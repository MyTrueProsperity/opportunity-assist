-- Rejected outputs when strategy generation regenerates once.
--
-- A completed model response that strategy-content validation rejects gets
-- exactly one automatic regeneration. Each rejected generation is kept on the
-- job in result.rejected_attempts (and the final rejected text, when the job
-- fails, in result.rejected_strategy as before). A job can therefore complete
-- with a rejected first generation, or fail with two.
--
-- Retention is unchanged: an application keeps rejected output on at most one
-- job, its latest; finishing any later job removes it from earlier jobs. The
-- lookup returns the latest job that has rejected output, FAILED or COMPLETED,
-- to workspace members only. Rejected output is never on the application.

create or replace function public.gf_strategy_job_finish(p_org uuid, p_job uuid, p_token uuid, p_status text, p_failure_code text, p_error text, p_result jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_app uuid;
begin
  if p_status not in ('COMPLETED','FAILED') then raise exception 'Invalid job status'; end if;
  update public.gf_strategy_jobs
     set status = p_status, finished_at = now(), failure_code = p_failure_code,
         last_error = left(p_error, 500), result = coalesce(p_result, '{}'::jsonb), lease_until = null
   where org_id = p_org and id = p_job and lease_token = p_token and status = 'RUNNING'
  returning application_id into v_app;
  if not found then return false; end if;
  update public.gf_strategy_jobs set result = result - 'rejected_strategy' - 'rejected_attempts'
   where org_id = p_org and application_id = v_app and id <> p_job
     and (result ? 'rejected_strategy' or result ? 'rejected_attempts');
  return true;
end $$;

create or replace function public.gf_strategy_job_rejection(p_org uuid, p_actor uuid, p_app uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare j public.gf_strategy_jobs;
begin
  if not exists (select 1 from public.gf_members where org_id = p_org and user_id = p_actor) then raise exception 'Membership required'; end if;
  select * into j from public.gf_strategy_jobs
   where org_id = p_org and application_id = p_app and status in ('FAILED','COMPLETED')
     and (result ? 'rejected_strategy' or result ? 'rejected_attempts')
   order by finished_at desc nulls last limit 1;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', j.id, 'application_id', j.application_id, 'status', j.status, 'failure_code', j.failure_code,
    'error', j.last_error, 'created_at', j.created_at, 'finished_at', j.finished_at,
    'application_revision', j.application_revision,
    'rejected_strategy', j.result -> 'rejected_strategy',
    'rejected_attempts', coalesce(j.result -> 'rejected_attempts', '[]'::jsonb),
    'attempts', coalesce(j.result -> 'attempts', '[]'::jsonb),
    'generations', j.result -> 'generations',
    'uncited_research', coalesce(j.result -> 'uncited_research', '[]'::jsonb),
    'unsupported_quantities', coalesce(j.result -> 'unsupported_quantities', '[]'::jsonb),
    'invalid_citations', coalesce(j.result -> 'invalid_citations', '[]'::jsonb),
    'cited_records', coalesce(j.result -> 'cited_records', '[]'::jsonb),
    'validation_ms', j.result -> 'validation_ms');
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'gf_strategy_job_finish(uuid,uuid,uuid,text,text,text,jsonb)', 'gf_strategy_job_rejection(uuid,uuid,uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
