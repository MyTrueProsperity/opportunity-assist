-- Trusted External Ingestion API for Source Intelligence.
--
-- Lets external trusted research systems (ChatGPT, Claude, internal agents,
-- future crawlers) submit funding-source candidates directly, through the
-- SAME normalization/dedup/quality/verification pipeline the human paste
-- import already uses (netlify/lib/source-intelligence/service.js:
-- submitCandidate, importBatch). This migration adds only the two concerns
-- that pipeline didn't need before: authenticating a non-human caller, and
-- tracking a batch's status/counts for that caller to poll.
--
-- Nothing here changes how source_candidates, funding_programs, source_jobs,
-- or any existing table behaves. Every ingested record still lands in the
-- same source_candidates queue and is subject to the same review/automatic-
-- approval rules as a manually pasted row.

create table if not exists public.api_credentials (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  source_system text not null check (source_system in ('CHATGPT','CLAUDE','OA_DISCOVERY_AGENT','MANUAL_UPLOAD','CSV_IMPORT','OTHER')),
  token_hash text not null unique,
  token_prefix text not null,  -- first chars of the plaintext, for display only -- never enough to reconstruct the token
  permissions text[] not null default array['SOURCE_INTELLIGENCE_IMPORT'],
  max_batch_size integer not null default 500 check (max_batch_size > 0 and max_batch_size <= 5000),
  daily_source_limit integer not null default 2000 check (daily_source_limit > 0),
  rate_limit_per_minute integer not null default 30 check (rate_limit_per_minute > 0),
  status text not null default 'active' check (status in ('active','disabled','revoked')),
  created_at timestamptz not null default now(),
  created_by uuid,  -- audit reference only; not a hard FK so this migration doesn't need to know about the profiles table
  last_used_at timestamptz,
  last_successful_submission_at timestamptz,
  revoked_at timestamptz
);
comment on table public.api_credentials is 'Service-to-service credentials for the Trusted External Ingestion API. Tokens are hashed; the plaintext is shown to the admin exactly once at creation and never stored.';
-- Backend-only, same pattern as source_candidates/funding_programs: the
-- admin/import functions read and write this with the service role. No
-- client-side Supabase call should ever touch this table directly.
alter table public.api_credentials enable row level security;

-- One row per request (not per source), covering both the per-minute rate
-- limit and the daily source-count limit from a single append-only log,
-- rather than two counters that could drift out of sync with each other.
create table if not exists public.api_credential_requests (
  id bigint generated always as identity primary key,
  credential_id uuid not null references public.api_credentials(id) on delete cascade,
  requested_at timestamptz not null default now(),
  mode text not null check (mode in ('DRY_RUN','QUEUE','TRUSTED_AUTOMATION')),
  sources_submitted integer not null default 0,
  batch_id uuid
);
create index if not exists api_credential_requests_credential_time_idx on public.api_credential_requests (credential_id, requested_at desc);
alter table public.api_credential_requests enable row level security;

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid references public.api_credentials(id),
  source_system text not null,
  batch_name text,
  submitted_by text,
  mode text not null check (mode in ('QUEUE','TRUSTED_AUTOMATION')),  -- DRY_RUN never persists a batch row
  state_code text not null,
  status text not null default 'RECEIVED' check (status in ('RECEIVED','SAVED','VERIFICATION_QUEUED','PARTIALLY_COMPLETED','NEEDS_REVIEW','IMPORTED','FAILED')),
  idempotency_key text,
  submitted_count integer not null default 0,
  processed_count integer not null default 0,
  new_candidate_count integer not null default 0,
  exact_duplicate_count integer not null default 0,
  possible_duplicate_count integer not null default 0,
  invalid_count integer not null default 0,
  verification_queued_count integer not null default 0,
  needs_review_count integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  run_id uuid references public.source_discovery_runs(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
comment on table public.import_batches is 'Status/count tracking for one Trusted External Ingestion submission. The underlying records live in source_import_rows/source_candidates exactly like a manual paste import; this table exists only so an external caller can poll batch-level progress.';
create index if not exists import_batches_credential_idx on public.import_batches (credential_id, created_at desc);
create unique index if not exists import_batches_idempotency_idx on public.import_batches (credential_id, idempotency_key) where idempotency_key is not null;
alter table public.import_batches enable row level security;

-- source_jobs.kind is a fixed check constraint, not an enum; add the one new
-- kind this feature needs. Drop-then-add is idempotent: the second run of
-- this migration drops the constraint this same statement just created and
-- adds back the identical definition.
alter table public.source_jobs drop constraint if exists source_jobs_kind_check;
alter table public.source_jobs add constraint source_jobs_kind_check check (kind in ('SEED','DISCOVER','MONITOR','VALIDATE','IMPORT','API_IMPORT'));

-- source_claim_job() also hardcodes which kinds it will claim, separate from
-- the table constraint above. API_IMPORT is cheap local work with no AI/
-- provider cost, same as IMPORT and SEED, so it needs no state-settings
-- gate here either -- verification for what it queues is still gated
-- exactly as before, inside the VALIDATE jobs it creates. This is otherwise
-- byte-for-byte the definition from 202609090007_source_florida_fill.sql;
-- create or replace is naturally idempotent, so no separate guard is needed.
create or replace function public.source_claim_job() returns setof public.source_jobs
language plpgsql security invoker set search_path=public as $f$
declare j public.source_jobs;
begin
 update source_jobs set status='FAILED',last_error='Lease expired after maximum attempts',finished_at=now() where status='RUNNING' and lease_until<now() and attempts>=3;
 update source_discovery_runs r set status='PARTIAL',finished_at=now(),errors=errors||jsonb_build_array('A job exhausted its lease retries') where status='RUNNING' and exists(select 1 from source_jobs failed_job where failed_job.run_id=r.id and failed_job.last_error='Lease expired after maximum attempts') and not exists(select 1 from source_jobs active_job where active_job.run_id=r.id and active_job.status in('QUEUED','RUNNING'));
 select q.* into j from source_jobs q left join source_state_settings s on s.state_code=q.state_code cross join source_engine_settings e
 where e.id=true and e.engine_enabled and q.attempts<3 and ((q.status='QUEUED' and q.available_at<=now()) or (q.status='RUNNING' and q.lease_until<now()))
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
