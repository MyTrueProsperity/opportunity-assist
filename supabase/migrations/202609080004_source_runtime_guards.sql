begin;
-- Pausing a state also pauses already queued validation/child-track jobs.
-- A budget pause automatically resumes after UTC rollover without consuming a retry.
create or replace function public.source_requeue_budget_jobs() returns integer
language plpgsql security invoker set search_path=public as $f$
declare affected integer;
begin
 update source_jobs set status='QUEUED',attempts=greatest(attempts-1,0),available_at=now(),last_error=null
 where status='PAUSED' and last_error like 'Daily state or global budget reached%'
 and created_at < date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'
 and coalesce(finished_at,available_at) < date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
 get diagnostics affected=row_count;
 update source_discovery_runs r set status='QUEUED',finished_at=null where r.status='PAUSED' and exists(select 1 from source_jobs j where j.run_id=r.id and j.status='QUEUED');
 return affected;
end $f$;
revoke all on function public.source_requeue_budget_jobs() from public,anon,authenticated;
grant execute on function public.source_requeue_budget_jobs() to service_role;
commit;
