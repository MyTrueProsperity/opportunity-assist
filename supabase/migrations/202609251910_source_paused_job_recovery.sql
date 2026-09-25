begin;
-- Paused-job recovery without retry churn (replaces the approach in PR #5).
--
-- Problem: a job paused for any reason other than the daily budget (engine or
-- state switched off, coverage category disabled) had no path back once the
-- condition cleared. source_requeue_budget_jobs() only handles the budget case.
--
-- Rules:
--   * Budget pauses keep their existing path. source_finish_job leaves
--     available_at = now() and source_requeue_budget_jobs() requeues them after
--     the UTC reset or a budget increase. source_claim_job never claims them
--     directly, so a budget-paused job cannot be claimed, re-paused and burn
--     attempts in a tight loop.
--   * Other pauses are not failures. source_finish_job gives the attempt back
--     and schedules the next check one hour out (backoff), so a job whose
--     condition persists is re-checked at most once an hour and never exhausts
--     its retries by being paused.
--   * source_claim_job may claim a due non-budget PAUSED job. It still applies
--     every existing gate (engine enabled, Florida validation, per-state
--     discovery/monitoring switches, attempts < 3), still uses FOR UPDATE SKIP
--     LOCKED and still issues a fresh lease token, so duplicate execution
--     protection is unchanged.
create or replace function public.source_finish_job(p_job uuid,p_token uuid,p_status text,p_error text default null) returns void
language plpgsql security invoker set search_path=public as $f$
declare j public.source_jobs; budget boolean := coalesce(p_error,'') like 'Daily state or global budget reached%';
begin
 if p_status not in('COMPLETED','FAILED','PAUSED','QUEUED') then raise exception 'Invalid job result'; end if;
 select * into j from source_jobs where id=p_job and lease_token=p_token and status='RUNNING' for update;
 if not found then raise exception 'Job lease lost'; end if;
 update source_jobs set status=p_status,last_error=p_error,
  finished_at=case when p_status in('COMPLETED','FAILED') then now() else null end,
  available_at=case when p_status='QUEUED' then now()+interval '2 hours'
                    when p_status='PAUSED' and budget then now()
                    when p_status='PAUSED' then now()+interval '1 hour'
                    else available_at end,
  attempts=case when p_status='PAUSED' and not budget then greatest(attempts-1,0) else attempts end,
  lease_until=null where id=p_job;
 -- Record every failure immediately, including when other jobs are still running.
 if p_error is not null then update source_discovery_runs set errors=errors||jsonb_build_array(jsonb_build_object('job_id',j.id,'source_url',j.payload->>'url','error',p_error)) where id=j.run_id; end if;
 if not exists(select 1 from source_jobs where run_id=j.run_id and status in('QUEUED','RUNNING')) then
  update source_discovery_runs set status=case when exists(select 1 from source_jobs where run_id=j.run_id and status='FAILED') then case when exists(select 1 from source_jobs where run_id=j.run_id and status='COMPLETED') then 'PARTIAL' else 'FAILED' end when exists(select 1 from source_jobs where run_id=j.run_id and status='PAUSED') then 'PAUSED' when coalesce((metrics->>'search_errors')::int,0)+coalesce((metrics->>'fetch_or_extraction_errors')::int,0)>0 then 'PARTIAL' else 'COMPLETED' end,finished_at=now() where id=j.run_id;
 end if;
end $f$;
revoke all on function public.source_finish_job(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.source_finish_job(uuid,uuid,text,text) to service_role;

create or replace function public.source_claim_job() returns setof public.source_jobs
language plpgsql security invoker set search_path=public as $f$
declare j public.source_jobs;
begin
 update source_jobs set status='FAILED',last_error='Lease expired after maximum attempts',finished_at=now() where status='RUNNING' and lease_until<now() and attempts>=3;
 update source_discovery_runs r set status='PARTIAL',finished_at=now(),errors=errors||jsonb_build_array('A job exhausted its lease retries') where status='RUNNING' and exists(select 1 from source_jobs failed_job where failed_job.run_id=r.id and failed_job.last_error='Lease expired after maximum attempts') and not exists(select 1 from source_jobs active_job where active_job.run_id=r.id and active_job.status in('QUEUED','RUNNING'));
 select q.* into j from source_jobs q left join source_state_settings s on s.state_code=q.state_code cross join source_engine_settings e
 where e.id=true and e.engine_enabled and q.attempts<3
 and ((q.status='QUEUED' and q.available_at<=now())
   or (q.status='PAUSED' and q.available_at<=now() and coalesce(q.last_error,'') not like 'Daily state or global budget reached%')
   or (q.status='RUNNING' and q.lease_until<now()))
 and (q.state_code is null or (q.state_code='FL' or e.florida_validated_at is not null))
 and (q.kind in('SEED','IMPORT','API_IMPORT') or (q.kind='VALIDATE' and (s.discovery_enabled or s.monitoring_enabled)) or (q.kind='DISCOVER' and s.discovery_enabled) or (q.kind='MONITOR' and s.monitoring_enabled))
 order by case q.kind when 'SEED' then 0 when 'IMPORT' then 1 when 'API_IMPORT' then 1 else 2 end,q.created_at,q.id
 for update of q skip locked limit 1;
 if not found then return; end if;
 update source_jobs set status='RUNNING',attempts=attempts+1,lease_until=now()+interval '14 minutes',lease_token=gen_random_uuid() where id=j.id returning * into j;
 update source_discovery_runs set status='RUNNING',started_at=coalesce(started_at,now()) where id=j.run_id;
 return next j;
end $f$;
revoke all on function public.source_claim_job() from public,anon,authenticated;
grant execute on function public.source_claim_job() to service_role;
commit;
