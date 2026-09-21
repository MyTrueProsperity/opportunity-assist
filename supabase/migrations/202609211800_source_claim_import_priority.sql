begin;
-- Every VALIDATE job -- whether it exists because the system found a lead
-- itself (DISCOVER/MONITOR) or because a source was imported (IMPORT/
-- API_IMPORT, from a manual paste or the Trusted External Ingestion API)
-- -- has fallen into the same priority tier here (case ... else 2 end),
-- so an import's own follow-up verification work competes chronologically
-- with the system's own ongoing discovery and monitoring. A VALIDATE job
-- inherits its run_id from whatever job created it, and importBatch/
-- importExternalBatch always pass runId:job.run_id when they enqueue a
-- follow-up VALIDATE for an unverified import (see service.js) -- so a
-- VALIDATE job's run strategy is reliably 'IMPORT' or 'API_IMPORT' when,
-- and only when, an import is what's actually waiting on it. That's
-- enough to identify it without a new column on source_jobs.
--
-- Giving those VALIDATE jobs the same priority tier as the IMPORT/
-- API_IMPORT container jobs themselves (still behind SEED, which is
-- unrelated, one-time corpus recovery) means an import's own verification
-- work is worked off before the system's own ongoing, never-ending
-- discovery and monitoring gets a turn -- matching the container job's
-- own priority instead of falling back to parity with organic work the
-- moment verification starts.
create or replace function public.source_claim_job() returns setof public.source_jobs
language plpgsql security invoker set search_path=public as $f$
declare j public.source_jobs;
begin
 update source_jobs set status='FAILED',last_error='Lease expired after maximum attempts',finished_at=now() where status='RUNNING' and lease_until<now() and attempts>=3;
 update source_discovery_runs r set status='PARTIAL',finished_at=now(),errors=errors||jsonb_build_array('A job exhausted its lease retries') where status='RUNNING' and exists(select 1 from source_jobs failed_job where failed_job.run_id=r.id and failed_job.last_error='Lease expired after maximum attempts') and not exists(select 1 from source_jobs active_job where active_job.run_id=r.id and active_job.status in('QUEUED','RUNNING'));
 select q.* into j from source_jobs q left join source_state_settings s on s.state_code=q.state_code left join source_discovery_runs dr on dr.id=q.run_id cross join source_engine_settings e
 where e.id=true and e.engine_enabled and q.attempts<3 and ((q.status in('QUEUED','PAUSED') and q.available_at<=now()) or (q.status='RUNNING' and q.lease_until<now()))
 and (q.state_code is null or (q.state_code='FL' or e.florida_validated_at is not null))
 and (q.kind in('SEED','IMPORT','API_IMPORT') or (q.kind='VALIDATE' and (s.discovery_enabled or s.monitoring_enabled)) or (q.kind='DISCOVER' and s.discovery_enabled) or (q.kind='MONITOR' and s.monitoring_enabled))
 order by case when q.kind='SEED' then 0 when q.kind in('IMPORT','API_IMPORT') then 1 when q.kind='VALIDATE' and dr.strategy in('IMPORT','API_IMPORT') then 1 else 2 end,q.created_at,q.id
 for update of q skip locked limit 1;
 if not found then return; end if;
 update source_jobs set status='RUNNING',attempts=attempts+1,lease_until=now()+interval '14 minutes',lease_token=gen_random_uuid() where id=j.id returning * into j;
 update source_discovery_runs set status='RUNNING',started_at=coalesce(started_at,now()) where id=j.run_id;
 return next j;
end $f$;
revoke all on function public.source_claim_job() from public,anon,authenticated;
grant execute on function public.source_claim_job() to service_role;
commit;
