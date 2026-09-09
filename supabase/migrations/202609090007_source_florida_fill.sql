begin;
-- Retain import identities and factual geography. This is a verification target,
-- not an assertion of eligibility. Unknown curated pages must not be stranded.
update public.funding_programs
 set search_state='FL',provenance=provenance||jsonb_build_object('search_routing','Florida corpus verification; eligibility unverified')
 where search_state is null and review_status='LEGACY_UNVERIFIED'
 and (provenance->>'origin' like 'github:%' or provenance->>'origin'='supabase:funder_watchlist');

-- All paid work shares chronological ordering so newly discovered child pages
-- cannot indefinitely jump ahead of older known-source checks.
create or replace function public.source_claim_job() returns setof public.source_jobs
language plpgsql security invoker set search_path=public as $f$
declare j public.source_jobs;
begin
 -- Locks and leases survive duplicate scheduler invocations. Exhausted retries are visible.
 update source_jobs set status='FAILED',last_error='Lease expired after maximum attempts',finished_at=now() where status='RUNNING' and lease_until<now() and attempts>=3;
 update source_discovery_runs r set status='PARTIAL',finished_at=now(),errors=errors||jsonb_build_array('A job exhausted its lease retries') where status='RUNNING' and exists(select 1 from source_jobs failed_job where failed_job.run_id=r.id and failed_job.last_error='Lease expired after maximum attempts') and not exists(select 1 from source_jobs active_job where active_job.run_id=r.id and active_job.status in('QUEUED','RUNNING'));
 select q.* into j from source_jobs q left join source_state_settings s on s.state_code=q.state_code cross join source_engine_settings e
 where e.id=true and e.engine_enabled and q.attempts<3 and ((q.status='QUEUED' and q.available_at<=now()) or (q.status='RUNNING' and q.lease_until<now()))
 and (q.state_code is null or (q.state_code='FL' or e.florida_validated_at is not null))
 and (q.kind in('SEED','IMPORT') or (q.kind='VALIDATE' and (s.discovery_enabled or s.monitoring_enabled)) or (q.kind='DISCOVER' and s.discovery_enabled) or (q.kind='MONITOR' and s.monitoring_enabled))
 order by case q.kind when 'SEED' then 0 when 'IMPORT' then 1 else 2 end,q.created_at,q.id
 for update of q skip locked limit 1;
 if not found then return; end if;
 update source_jobs set status='RUNNING',attempts=attempts+1,lease_until=now()+interval '14 minutes',lease_token=gen_random_uuid() where id=j.id returning * into j;
 update source_discovery_runs set status='RUNNING',started_at=coalesce(started_at,now()) where id=j.run_id;
 return next j;
end $f$;

-- A higher authorized limit should resume work now instead of waiting overnight.
-- Recheck remaining capacity; a pause after the same configuration change does
-- not immediately loop back into the queue.
create or replace function public.source_requeue_budget_jobs() returns integer
language plpgsql security invoker set search_path=public as $f$
declare affected integer;
begin
 update source_jobs q set status='QUEUED',attempts=greatest(q.attempts-1,0),available_at=now(),last_error=null
 from source_state_settings s,source_engine_settings e
 where q.state_code=s.state_code and e.id=true and e.engine_enabled
 and q.status='PAUSED' and q.last_error like 'Daily state or global budget reached%'
 and (q.state_code='FL' or e.florida_validated_at is not null)
 and ((q.kind='DISCOVER' and s.discovery_enabled) or (q.kind='MONITOR' and s.monitoring_enabled) or (q.kind='VALIDATE' and (s.discovery_enabled or s.monitoring_enabled)))
 and (
  (q.created_at < date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'
   and coalesce(q.finished_at,q.available_at) < date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')
  or (
   greatest(s.updated_at,e.updated_at)>coalesce(q.finished_at,q.available_at)
   and coalesce((select u.pages from source_daily_usage u where u.state_code=s.state_code and u.usage_date=(now() at time zone 'UTC')::date),0)<s.daily_page_limit
   and (q.kind<>'DISCOVER' or coalesce((select u.queries from source_daily_usage u where u.state_code=s.state_code and u.usage_date=(now() at time zone 'UTC')::date),0)+2<=s.daily_query_limit)
   and coalesce((select u.reserved_usd from source_daily_usage u where u.state_code=s.state_code and u.usage_date=(now() at time zone 'UTC')::date),0)<s.daily_budget_usd
   and coalesce((select sum(u.reserved_usd) from source_daily_usage u where u.usage_date=(now() at time zone 'UTC')::date),0)<e.daily_budget_usd
  )
 );
 get diagnostics affected=row_count;
 update source_discovery_runs r set status='QUEUED',finished_at=null where r.status='PAUSED' and exists(select 1 from source_jobs j where j.run_id=r.id and j.status='QUEUED');
 return affected;
end $f$;
revoke all on function public.source_claim_job(),public.source_requeue_budget_jobs() from public,anon,authenticated;
grant execute on function public.source_claim_job(),public.source_requeue_budget_jobs() to service_role;
commit;
