begin;
alter table public.source_candidates add column if not exists automatic_approval_error text;
alter table public.source_candidates add column if not exists automatic_approval_retry_at timestamptz not null default now();

-- A failing candidate gets a bounded retry delay instead of blocking the oldest
-- backlog page, every other approval, and all imports on every invocation.
create or replace function public.source_automatic_candidates(p_limit integer default 10) returns setof public.source_candidates
language sql security invoker set search_path=public as $f$
 select c.* from source_candidates c
 join source_state_settings s on s.state_code=c.state_code
 cross join source_engine_settings e
 where e.id and e.engine_enabled and e.automatic_approval_enabled
 and (s.discovery_enabled or s.monitoring_enabled) and (s.state_code='FL' or e.florida_validated_at is not null)
 and c.status in('PENDING','MATCHED','INVESTIGATING') and c.quality_ready and c.last_verified_at>=now()-interval '7 days'
 and c.automatic_approval_retry_at<=now()
 and coalesce(c.proposed->'evidence' ?& array['program_name','funding_mechanism','applicable_states'],false)
 and coalesce(c.proposed->'applicable_states' ? c.state_code,false)
 and coalesce(c.proposed->>'program_name','')<>'' and coalesce(c.proposed->>'funding_mechanism','')<>'' and c.duplicate_outcome<>'REJECT'
 and not exists(select 1 from source_review_decisions d where d.candidate_id=c.id and d.decision_origin='MANUAL')
 order by c.first_seen_at,c.id limit greatest(0,least(p_limit,25));
$f$;

create or replace function public.source_import_progress(p_state text default null) returns jsonb
language sql security invoker set search_path=public as $f$
 select jsonb_build_object(
  'imports_queued',(select count(*) from source_jobs where kind='IMPORT' and status='QUEUED' and (p_state is null or state_code=p_state)),
  'imports_running',(select count(*) from source_jobs where kind='IMPORT' and status='RUNNING' and (p_state is null or state_code=p_state)),
  'imports_completed',(select count(*) from source_jobs where kind='IMPORT' and status='COMPLETED' and (p_state is null or state_code=p_state)),
  'imports_failed',(select count(*) from source_jobs where kind='IMPORT' and status in('FAILED','PAUSED') and (p_state is null or state_code=p_state)),
  'rows_staged',(select count(*) from source_import_rows i join source_jobs j on j.run_id::text=split_part(i.origin_id,':',1) and j.kind='IMPORT' where i.origin='manual' and (p_state is null or j.state_code=p_state)),
  'invalid_rows',(select count(*) from source_import_rows i join source_jobs j on j.run_id::text=split_part(i.origin_id,':',1) and j.kind='IMPORT' where i.origin='manual' and i.import_error is not null and (p_state is null or j.state_code=p_state)),
  'verification_queued',(select count(*) from source_jobs where kind in('VALIDATE','MONITOR') and status in('QUEUED','RUNNING') and (p_state is null or state_code=p_state)),
  'verification_budget_paused',(select count(*) from source_jobs where kind in('VALIDATE','MONITOR') and status='PAUSED' and last_error like 'Daily state or global budget reached%' and (p_state is null or state_code=p_state)),
  'approval_errors',(select count(*) from source_candidates where status in('PENDING','MATCHED','INVESTIGATING') and automatic_approval_error is not null and (p_state is null or state_code=p_state)),
  'registry_total',(select count(*) from funding_programs where superseded_by is null),
  'global_reserved_usd',(select coalesce(sum(reserved_usd),0) from source_daily_usage where usage_date=(now() at time zone 'UTC')::date),
  'global_budget_usd',(select daily_budget_usd from source_engine_settings where id),
  'budget_resets_at',((date_trunc('day',now() at time zone 'UTC')+interval '1 day') at time zone 'UTC')
 );
$f$;
revoke all on function public.source_import_progress(text) from public,anon,authenticated;
grant execute on function public.source_import_progress(text) to service_role;
commit;
