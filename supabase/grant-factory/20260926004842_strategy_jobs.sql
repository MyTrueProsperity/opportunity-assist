-- Background strategy generation for Grant Factory.
--
-- Strategy asks the model for nine substantial sections, which can take
-- longer than a synchronous web request allows. A strategy request now
-- creates a job here; a background function claims it, runs the same bounded
-- evidence selection and model call, and saves the strategy atomically.
--
-- Conventions follow public.source_jobs: QUEUED, RUNNING, COMPLETED, FAILED;
-- one active job per key (a partial unique index); a lease that marks a job
-- FAILED if its worker never finishes. Rows hold job metadata only (ids,
-- counts, selected record ids and reasons, request size, token usage), never
-- research text or the strategy itself, which is saved on the application.
-- Access is server-only (service_role), like the other gf_ tables' writes.

create table if not exists public.gf_strategy_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.gf_workspaces,
  application_id uuid not null,
  requested_by uuid not null,
  status text not null default 'QUEUED' check (status in ('QUEUED','RUNNING','COMPLETED','FAILED')),
  input_hash text not null,
  application_revision integer not null,
  brain_revision integer,
  attempts integer not null default 0,
  lease_until timestamptz,
  lease_token uuid,
  dispatched_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  failure_code text,
  last_error text,
  result jsonb not null default '{}'
);
-- One queued or running strategy job per application: repeated clicks join it.
create unique index if not exists gf_strategy_jobs_active on public.gf_strategy_jobs(org_id, application_id) where status in ('QUEUED','RUNNING');
create index if not exists gf_strategy_jobs_recent on public.gf_strategy_jobs(org_id, application_id, created_at desc);
alter table public.gf_strategy_jobs enable row level security;
revoke all on public.gf_strategy_jobs from public, anon, authenticated;
grant all on public.gf_strategy_jobs to service_role;

-- Fail jobs whose worker can no longer finish, so the application can be
-- retried. RUNNING past its lease: the worker ended (timeout or crash).
-- QUEUED for 10 minutes: no worker ever claimed it.
create or replace function public.gf_strategy_jobs_expire(p_org uuid, p_app uuid)
returns void language sql security invoker set search_path = '' as $$
  update public.gf_strategy_jobs
     set status = 'FAILED', finished_at = now(),
         failure_code = case when status = 'RUNNING' then 'TIMEOUT' else 'NOT_STARTED' end,
         last_error = case when status = 'RUNNING'
           then 'Strategy generation did not finish within its time limit. Nothing was saved; generate again.'
           else 'Strategy generation did not start. Nothing was saved; generate again.' end
   where org_id = p_org and application_id = p_app
     and ((status = 'RUNNING' and lease_until < now())
       or (status = 'QUEUED' and created_at < now() - interval '10 minutes'));
$$;

-- AI run records left RUNNING by a function that ended before the model call
-- returned. Nothing can complete them after 15 minutes (the longest a Netlify
-- function can run), so they are marked FAILED with the reason. Completed and
-- failed runs, and their token counts, are never changed.
create or replace function public.gf_expire_abandoned_ai_runs(p_org uuid)
returns integer language plpgsql security invoker set search_path = '' as $$
declare n integer;
begin
  update public.gf_ai_runs
     set status = 'FAILED', completed_at = now(),
         error = 'Abandoned: the request ended before the AI call returned (no completion was recorded within 15 minutes).'
   where org_id = p_org and status = 'RUNNING' and created_at < now() - interval '15 minutes';
  get diagnostics n = row_count;
  return n;
end $$;

-- Queue a strategy job, or return the application's active one.
create or replace function public.gf_strategy_job_enqueue(p_org uuid, p_actor uuid, p_app uuid, p_input_hash text, p_app_revision integer, p_brain_revision integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare j public.gf_strategy_jobs;
begin
  if not exists (select 1 from public.gf_members where org_id = p_org and user_id = p_actor) then raise exception 'Membership required'; end if;
  -- Serializes enqueue per application and proves the application is in this workspace.
  perform 1 from public.gf_applications where org_id = p_org and id = p_app for update;
  if not found then raise exception 'Application not found.'; end if;
  perform public.gf_strategy_jobs_expire(p_org, p_app);
  perform public.gf_expire_abandoned_ai_runs(p_org);
  select * into j from public.gf_strategy_jobs where org_id = p_org and application_id = p_app and status in ('QUEUED','RUNNING');
  if found then return jsonb_build_object('created', false, 'job', to_jsonb(j) - 'lease_token'); end if;
  insert into public.gf_strategy_jobs(org_id, application_id, requested_by, input_hash, application_revision, brain_revision)
  values (p_org, p_app, p_actor, p_input_hash, p_app_revision, p_brain_revision) returning * into j;
  return jsonb_build_object('created', true, 'job', to_jsonb(j) - 'lease_token');
end $$;

-- Claim a queued job for this workspace. Returns null if it is not QUEUED
-- (already claimed, finished or expired), so duplicate dispatches are harmless.
create or replace function public.gf_strategy_job_claim(p_org uuid, p_actor uuid, p_job uuid, p_lease_seconds integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare j public.gf_strategy_jobs;
begin
  if not exists (select 1 from public.gf_members where org_id = p_org and user_id = p_actor) then raise exception 'Membership required'; end if;
  update public.gf_strategy_jobs
     set status = 'RUNNING', attempts = attempts + 1, started_at = now(),
         lease_until = now() + make_interval(secs => greatest(60, least(p_lease_seconds, 840))),
         lease_token = gen_random_uuid()
   where org_id = p_org and id = p_job and status = 'QUEUED'
  returning * into j;
  if not found then return null; end if;
  return to_jsonb(j);
end $$;

-- Confirm, immediately before saving, that this worker still holds a live
-- lease, and extend it for the save. A worker whose job already expired
-- (and was reported as failed) must not save anything.
create or replace function public.gf_strategy_job_hold(p_org uuid, p_job uuid, p_token uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.gf_strategy_jobs set lease_until = now() + interval '60 seconds'
   where org_id = p_org and id = p_job and lease_token = p_token and status = 'RUNNING' and lease_until > now();
  return found;
end $$;

-- Finish a job. Only the worker holding the lease can finish it, and only
-- while it is still RUNNING (an expired job stays FAILED).
create or replace function public.gf_strategy_job_finish(p_org uuid, p_job uuid, p_token uuid, p_status text, p_failure_code text, p_error text, p_result jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_status not in ('COMPLETED','FAILED') then raise exception 'Invalid job status'; end if;
  update public.gf_strategy_jobs
     set status = p_status, finished_at = now(), failure_code = p_failure_code,
         last_error = left(p_error, 500), result = coalesce(p_result, '{}'::jsonb), lease_until = null
   where org_id = p_org and id = p_job and lease_token = p_token and status = 'RUNNING';
  return found;
end $$;

-- Latest job for an application, after expiring any that can no longer finish.
create or replace function public.gf_strategy_job_status(p_org uuid, p_actor uuid, p_app uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare j public.gf_strategy_jobs;
begin
  if not exists (select 1 from public.gf_members where org_id = p_org and user_id = p_actor) then raise exception 'Membership required'; end if;
  perform public.gf_strategy_jobs_expire(p_org, p_app);
  select * into j from public.gf_strategy_jobs where org_id = p_org and application_id = p_app order by created_at desc limit 1;
  if not found then return null; end if;
  return to_jsonb(j) - 'lease_token';
end $$;

-- Record a successful dispatch (used to decide whether a queued job needs another).
create or replace function public.gf_strategy_job_dispatched(p_org uuid, p_job uuid)
returns void language sql security invoker set search_path = '' as $$
  update public.gf_strategy_jobs set dispatched_at = now() where org_id = p_org and id = p_job and status = 'QUEUED';
$$;

do $$ declare f text; begin
  foreach f in array array[
    'gf_strategy_jobs_expire(uuid,uuid)', 'gf_expire_abandoned_ai_runs(uuid)',
    'gf_strategy_job_enqueue(uuid,uuid,uuid,text,integer,integer)', 'gf_strategy_job_claim(uuid,uuid,uuid,integer)',
    'gf_strategy_job_finish(uuid,uuid,uuid,text,text,text,jsonb)', 'gf_strategy_job_status(uuid,uuid,uuid)',
    'gf_strategy_job_dispatched(uuid,uuid)', 'gf_strategy_job_hold(uuid,uuid,uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
notify pgrst, 'reload schema';
