begin;
-- A PAUSED job's normal path back to QUEUED is source_requeue_budget_jobs()
-- (called every worker cycle, before the claim loop -- see runWorker in
-- worker.js), but that function only recognizes one specific pause reason:
-- last_error like 'Daily state or global budget reached%'. A job paused
-- for any other reason worker.js's gate() throws (the engine or a state
-- disabled, a coverage category turned off) has no path back at all, even
-- once the condition that paused it is resolved -- it sits there
-- permanently until someone manually resets its status.
--
-- source_claim_job reclaiming a due PAUSED job directly, as a general
-- fallback, closes that gap without touching source_requeue_budget_jobs's
-- own more specific handling, which still runs first every cycle exactly
-- as before. It's safe purely on available_at: source_claim_job already
-- re-checks engine_enabled, per-state discovery/monitoring flags and
-- florida_validated_at independently on every call, regardless of a job's
-- status, so a job paused because a state was genuinely disabled still
-- won't be claimed unless that's actually changed since -- reclaiming it
-- here doesn't bypass that, it just lets it be reconsidered instead of
-- being skipped forever. If the same condition still applies (the budget
-- included), the job simply gets paused again, exactly as a retried
-- QUEUED job already would.
create or replace function public.source_claim_job() returns setof public.source_jobs
language plpgsql security invoker set search_path=public as $f$
declare j public.source_jobs;
begin
 update source_jobs set status='FAILED',last_error='Lease expired after maximum attempts',finished_at=now() where status='RUNNING' and lease_until<now() and attempts>=3;
 update source_discovery_runs r set status='PARTIAL',finished_at=now(),errors=errors||jsonb_build_array('A job exhausted its lease retries') where status='RUNNING' and exists(select 1 from source_jobs failed_job where failed_job.run_id=r.id and failed_job.last_error='Lease expired after maximum attempts') and not exists(select 1 from source_jobs active_job where active_job.run_id=r.id and active_job.status in('QUEUED','RUNNING'));
 select q.* into j from source_jobs q left join source_state_settings s on s.state_code=q.state_code cross join source_engine_settings e
 where e.id=true and e.engine_enabled and q.attempts<3 and ((q.status in('QUEUED','PAUSED') and q.available_at<=now()) or (q.status='RUNNING' and q.lease_until<now()))
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
