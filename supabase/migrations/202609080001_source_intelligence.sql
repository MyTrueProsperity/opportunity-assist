-- Additive source intelligence registry. Existing tables/data/policies are preserved.
begin;

create table if not exists public.source_engine_settings (
  id boolean primary key default true check(id),
  engine_enabled boolean not null default false,
  seed_completed_at timestamptz,
  florida_validation_run_id uuid,
  florida_validated_at timestamptz,
  florida_validated_by uuid,
  daily_budget_usd numeric(10,2) not null default 3 check(daily_budget_usd between 0 and 100),
  updated_at timestamptz not null default now()
);
insert into public.source_engine_settings(id) values(true) on conflict do nothing;

create table if not exists public.source_state_settings (
  state_code text primary key check(state_code ~ '^[A-Z]{2}$'),
  state_name text not null,
  discovery_enabled boolean not null default false,
  monitoring_enabled boolean not null default false,
  publication_enabled boolean not null default false,
  daily_query_limit integer not null default 4 check(daily_query_limit between 0 and 100),
  daily_page_limit integer not null default 25 check(daily_page_limit between 0 and 1000),
  daily_budget_usd numeric(10,2) not null default 1 check(daily_budget_usd between 0 and 100),
  categories text[] not null default '{}',
  enabled_at timestamptz,
  updated_at timestamptz not null default now()
);
create table if not exists public.source_geographies (
  id uuid primary key default gen_random_uuid(),
  state_code text not null references public.source_state_settings,
  kind text not null check(kind in('state','county','municipality','region','special_district','national')),
  name text not null,
  parent_id uuid references public.source_geographies,
  provenance jsonb not null default '{}',
  unique(state_code,kind,name)
);
create table if not exists public.source_coverage (
  id uuid primary key default gen_random_uuid(),
  geography_id uuid not null references public.source_geographies,
  state_code text not null references public.source_state_settings,
  category text not null,
  query_rotation integer not null default 0,
  last_attempted_at timestamptz,
  last_searched_at timestamptz,
  last_comprehensive_at timestamptz,
  next_search_at timestamptz not null default now(),
  successful_sweeps integer not null default 0,
  candidates_found integer not null default 0,
  last_run_id uuid,
  last_error text,
  unique(geography_id,category)
);
create index if not exists source_coverage_due_idx on public.source_coverage(state_code,next_search_at);

create table if not exists public.funding_organizations (
  id uuid primary key default gen_random_uuid(),
  identity_key text not null unique,
  canonical_name text not null,
  normalized_name text not null,
  organization_type text,
  website_domain text,
  primary_url text,
  state text,
  geographic_scope text,
  active_status text not null default 'ACTIVE',
  discovered_at timestamptz not null default now(),
  first_verified_at timestamptz,
  last_verified_at timestamptz,
  last_changed_at timestamptz,
  source_confidence numeric,
  notes text,
  provenance jsonb not null default '{}'
);
create index if not exists funding_org_name_idx on public.funding_organizations(normalized_name);
create index if not exists funding_org_domain_idx on public.funding_organizations(website_domain);
create table if not exists public.funding_programs (
  id uuid primary key default gen_random_uuid(),
  identity_key text not null unique,
  organization_id uuid references public.funding_organizations,
  source_name text not null,
  canonical_program_name text,
  normalized_program_name text not null,
  normalized_organization_name text,
  source_url text not null check(source_url ~ '^https?://'),
  normalized_url text not null,
  application_url text,
  website_domain text not null,
  source_type text,
  geography text,
  applicable_states text[] not null default '{}',
  search_state text references public.source_state_settings,
  keywords text[] not null default '{}',
  applicant_types text[] not null default '{}',
  funding_categories text[] not null default '{}',
  purpose text,
  eligibility text,
  funding_mechanism text,
  funding_pool text,
  administering_unit text,
  summary text,
  recurring_status text,
  recurrence_pattern text,
  typical_open_month integer check(typical_open_month between 1 and 12),
  typical_deadline_month integer check(typical_deadline_month between 1 and 12),
  award_min numeric check(award_min>=0),
  award_max numeric check(award_max>=0),
  match_required boolean,
  loi_required boolean,
  current_status text not null default 'UNKNOWN',
  current_cycle_open boolean,
  current_deadline date,
  last_cycle_seen text,
  expected_next_cycle date,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_attempted_at timestamptz,
  last_verified_at timestamptz,
  last_changed_at timestamptz,
  next_scan_at timestamptz not null default now(),
  consecutive_failures integer not null default 0,
  content_hash text,
  semantic_fingerprint text[] not null default '{}',
  confidence_score numeric,
  review_status text not null default 'LEGACY_UNVERIFIED' check(review_status in('LEGACY_UNVERIFIED','APPROVED','SUPERSEDED')),
  evidence jsonb not null default '{}',
  provenance jsonb not null default '{}',
  active boolean not null default false,
  superseded_by uuid references public.funding_programs,
  check(award_min is null or award_max is null or award_min<=award_max),
  check(superseded_by is null or superseded_by<>id)
);
create index if not exists funding_program_url_idx on public.funding_programs(normalized_url);
create index if not exists funding_program_org_idx on public.funding_programs(organization_id,normalized_program_name);
create index if not exists funding_program_domain_idx on public.funding_programs(website_domain);
create index if not exists funding_program_due_idx on public.funding_programs(search_state,next_scan_at) where superseded_by is null;
create index if not exists funding_program_states_idx on public.funding_programs using gin(applicable_states);

create table if not exists public.source_aliases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.funding_organizations,
  program_id uuid references public.funding_programs,
  alias_type text not null check(alias_type in('name','url','external_id')),
  value text not null,
  normalized_value text not null,
  provenance jsonb not null default '{}',
  created_at timestamptz not null default now(),
  check(organization_id is not null or program_id is not null)
);
create unique index if not exists source_alias_program_unique on public.source_aliases(program_id,alias_type,normalized_value);
create index if not exists source_alias_lookup on public.source_aliases(alias_type,normalized_value);

create table if not exists public.source_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  strategy text not null,
  state_code text references public.source_state_settings,
  geography_id uuid references public.source_geographies,
  category text,
  status text not null default 'QUEUED' check(status in('QUEUED','RUNNING','COMPLETED','PARTIAL','FAILED','PAUSED')),
  requested_by uuid,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  metrics jsonb not null default '{}',
  errors jsonb not null default '[]',
  queries jsonb not null default '[]',
  clean_room boolean not null default false,
  validation jsonb,
  validated_by uuid,
  validated_at timestamptz,
  estimated_cost_usd numeric(12,6) not null default 0
);
create table if not exists public.source_candidates (
  id uuid primary key default gen_random_uuid(),
  identity_key text not null unique,
  source_name text not null,
  source_url text not null check(source_url ~ '^https?://'),
  normalized_url text not null,
  state_code text references public.source_state_settings,
  proposed jsonb not null default '{}',
  scores jsonb not null default '{}',
  duplicate_matches jsonb not null default '[]',
  duplicate_outcome text not null default 'POSSIBLE_DUPLICATE_REVIEW' check(duplicate_outcome in('NEW','EXISTING','MATERIAL_DISTINCT_TRACK','POSSIBLE_DUPLICATE_REVIEW','REJECT')),
  matched_program_id uuid references public.funding_programs,
  reason text,
  reason_code text,
  quality_ready boolean not null default false,
  status text not null default 'PENDING' check(status in('PENDING','APPROVED','MERGED','UPDATED','REJECTED','INVESTIGATING','MATCHED')),
  discovery_method text not null,
  first_run_id uuid references public.source_discovery_runs,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_verified_at timestamptz,
  version integer not null default 1
);
create index if not exists source_candidate_queue_idx on public.source_candidates(status,first_seen_at);
create index if not exists source_candidate_url_idx on public.source_candidates(normalized_url);
create table if not exists public.source_import_rows (
  id uuid primary key default gen_random_uuid(),
  import_key text not null unique,
  origin text not null,
  origin_id text not null,
  raw_row jsonb not null,
  program_id uuid references public.funding_programs,
  candidate_id uuid references public.source_candidates,
  import_error text,
  imported_at timestamptz not null default now()
);
create table if not exists public.source_candidate_sightings (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.source_candidates,
  run_id uuid references public.source_discovery_runs,
  observation_key text not null unique,
  provenance jsonb not null,
  seen_at timestamptz not null default now()
);
create table if not exists public.source_review_decisions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.source_candidates,
  actor_id uuid not null,
  action text not null,
  reason_code text,
  notes text not null default '',
  target_program_id uuid references public.funding_programs,
  before_snapshot jsonb not null default '{}',
  after_snapshot jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists source_decisions_candidate_idx on public.source_review_decisions(candidate_id,created_at);
create table if not exists public.source_scan_history (
  id uuid primary key default gen_random_uuid(),
  program_id uuid references public.funding_programs,
  candidate_id uuid references public.source_candidates,
  run_id uuid references public.source_discovery_runs,
  scanned_at timestamptz not null default now(),
  http_status integer,
  source_url text not null,
  resolved_url text,
  page_hash text,
  change_detected boolean,
  extraction_result jsonb,
  model text,
  confidence jsonb,
  error text,
  duration_ms integer,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  estimated_cost_usd numeric(12,6) not null default 0
);
create index if not exists source_scan_program_idx on public.source_scan_history(program_id,scanned_at desc);
create table if not exists public.source_page_cache (
  normalized_url text primary key,
  resolved_url text,
  page_hash text,
  extracted jsonb,
  links jsonb not null default '[]',
  etag text,
  last_modified text,
  fetched_at timestamptz not null default now()
);
create table if not exists public.funding_cycles (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.funding_programs,
  cycle_key text not null,
  opportunity_id uuid references public.opportunities,
  status text not null,
  deadline date,
  evidence jsonb not null default '{}',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique(program_id,cycle_key)
);
alter table public.opportunities add column if not exists funding_program_id uuid references public.funding_programs;
alter table public.opportunities add column if not exists source_cycle_id uuid references public.funding_cycles;
alter table public.opportunities add column if not exists source_active boolean not null default true;
alter table public.opportunities add column if not exists source_verified_at timestamptz;
create index if not exists opportunities_program_idx on public.opportunities(funding_program_id);

create table if not exists public.source_jobs (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null,
  run_id uuid not null references public.source_discovery_runs,
  state_code text references public.source_state_settings,
  kind text not null check(kind in('SEED','DISCOVER','MONITOR','VALIDATE','IMPORT')),
  payload jsonb not null default '{}',
  status text not null default 'QUEUED' check(status in('QUEUED','RUNNING','COMPLETED','FAILED','PAUSED')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token uuid,
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists source_jobs_active_key on public.source_jobs(dedupe_key) where status in('QUEUED','RUNNING');
create index if not exists source_jobs_claim_idx on public.source_jobs(status,available_at);
create table if not exists public.source_daily_usage (
  usage_date date not null,
  state_code text not null,
  queries integer not null default 0,
  pages integer not null default 0,
  reserved_usd numeric(12,6) not null default 0,
  primary key(usage_date,state_code)
);

-- All mutations go through a server-authorized endpoint or trusted worker.
-- Admins have read-only access; no normal account can alter evidence or audit logs.
do $block$
declare t text;
begin
 foreach t in array array['source_engine_settings','source_state_settings','source_geographies','source_coverage','funding_organizations','funding_programs','source_aliases','source_discovery_runs','source_candidates','source_import_rows','source_candidate_sightings','source_review_decisions','source_scan_history','source_page_cache','funding_cycles','source_jobs','source_daily_usage'] loop
   execute format('alter table public.%I enable row level security',t);
   execute format('revoke all on public.%I from anon, authenticated',t);
   execute format('grant select on public.%I to authenticated',t);
   execute format('grant all on public.%I to service_role',t);
   if not exists(select 1 from pg_policies where schemaname='public' and tablename=t and policyname='source_admin_read') then
     execute format('create policy source_admin_read on public.%I for select to authenticated using (exists(select 1 from public.admins where profile_id=(select auth.uid())))',t);
   end if;
 end loop;
end $block$;

create or replace function public.source_require_actor(p_actor uuid) returns void
language plpgsql security invoker set search_path=public as $f$
begin
 if p_actor is null or not exists(select 1 from public.admins where profile_id=p_actor) then raise exception 'Administrator required' using errcode='42501'; end if;
end $f$;

create or replace function public.source_set_state(p_actor uuid,p_state text,p_patch jsonb) returns jsonb
language plpgsql security invoker set search_path=public as $f$
declare s public.source_state_settings; e public.source_engine_settings;
begin
 perform public.source_require_actor(p_actor);
 select * into e from source_engine_settings where id=true for update;
 select * into s from source_state_settings where state_code=p_state for update;
 if not found then raise exception 'Unknown state'; end if;
 if p_state<>'FL' and e.florida_validated_at is null and (coalesce((p_patch->>'discovery_enabled')::boolean,false) or coalesce((p_patch->>'monitoring_enabled')::boolean,false) or coalesce((p_patch->>'publication_enabled')::boolean,false)) then raise exception 'Review and validate Florida before enabling another state'; end if;
 insert into source_review_decisions(actor_id,action,notes,before_snapshot,after_snapshot) values(p_actor,'STATE_CONFIGURATION',p_state,to_jsonb(s),p_patch);
 update source_state_settings set discovery_enabled=coalesce((p_patch->>'discovery_enabled')::boolean,discovery_enabled), monitoring_enabled=coalesce((p_patch->>'monitoring_enabled')::boolean,monitoring_enabled), publication_enabled=coalesce((p_patch->>'publication_enabled')::boolean,publication_enabled), daily_query_limit=coalesce((p_patch->>'daily_query_limit')::integer,daily_query_limit),daily_page_limit=coalesce((p_patch->>'daily_page_limit')::integer,daily_page_limit), daily_budget_usd=coalesce((p_patch->>'daily_budget_usd')::numeric,daily_budget_usd),categories=case when p_patch ? 'categories' then array(select jsonb_array_elements_text(p_patch->'categories')) else categories end,enabled_at=case when (p_patch->>'discovery_enabled')::boolean then coalesce(enabled_at,now()) else enabled_at end,updated_at=now() where state_code=p_state returning * into s;
 return to_jsonb(s);
end $f$;

create or replace function public.source_claim_job() returns setof public.source_jobs
language plpgsql security invoker set search_path=public as $f$
declare j public.source_jobs;
begin
 -- Locks and leases survive duplicate scheduler invocations. Exhausted retries are visible.
 update source_jobs set status='FAILED',last_error='Lease expired after maximum attempts',finished_at=now() where status='RUNNING' and lease_until<now() and attempts>=3;
 update source_discovery_runs r set status='PARTIAL',finished_at=now(),errors=errors||jsonb_build_array('A job exhausted its lease retries') where status='RUNNING' and exists(select 1 from source_jobs j where j.run_id=r.id and j.last_error='Lease expired after maximum attempts') and not exists(select 1 from source_jobs j where j.run_id=r.id and j.status in('QUEUED','RUNNING'));
 select q.* into j from source_jobs q left join source_state_settings s on s.state_code=q.state_code cross join source_engine_settings e
 where e.id=true and e.engine_enabled and q.attempts<3 and ((q.status='QUEUED' and q.available_at<=now()) or (q.status='RUNNING' and q.lease_until<now()))
 and (q.state_code is null or (q.state_code='FL' or e.florida_validated_at is not null))
 and (q.kind in('SEED','IMPORT') or (q.kind='VALIDATE' and (s.discovery_enabled or s.monitoring_enabled)) or (q.kind='DISCOVER' and s.discovery_enabled) or (q.kind='MONITOR' and s.monitoring_enabled))
 order by case q.kind when 'SEED' then 0 when 'IMPORT' then 1 when 'VALIDATE' then 2 else 3 end,q.created_at
 for update of q skip locked limit 1;
 if not found then return; end if;
 update source_jobs set status='RUNNING',attempts=attempts+1,lease_until=now()+interval '14 minutes',lease_token=gen_random_uuid() where id=j.id returning * into j;
 update source_discovery_runs set status='RUNNING',started_at=coalesce(started_at,now()) where id=j.run_id;
 return next j;
end $f$;

create or replace function public.source_reserve_usage(p_state text,p_queries integer,p_pages integer,p_usd numeric) returns boolean
language plpgsql security invoker set search_path=public as $f$
declare e public.source_engine_settings;s public.source_state_settings;u public.source_daily_usage;total numeric;
begin
 if p_queries<0 or p_pages<0 or p_usd<0 then raise exception 'Invalid reservation'; end if;
 select * into e from source_engine_settings where id=true for update;
 if not e.engine_enabled then return false; end if;
 select * into s from source_state_settings where state_code=p_state;
 if not found or (p_state<>'FL' and e.florida_validated_at is null) then return false; end if;
 insert into source_daily_usage(usage_date,state_code) values((now() at time zone 'UTC')::date,p_state) on conflict do nothing;
 select * into u from source_daily_usage where usage_date=(now() at time zone 'UTC')::date and state_code=p_state for update;
 select coalesce(sum(reserved_usd),0) into total from source_daily_usage where usage_date=(now() at time zone 'UTC')::date;
 if u.queries+p_queries>s.daily_query_limit or u.pages+p_pages>s.daily_page_limit or u.reserved_usd+p_usd>s.daily_budget_usd or total+p_usd>e.daily_budget_usd then return false; end if;
 update source_daily_usage set queries=queries+p_queries,pages=pages+p_pages,reserved_usd=reserved_usd+p_usd where usage_date=u.usage_date and state_code=p_state;
 return true;
end $f$;

create or replace function public.source_add_metrics(p_run uuid,p_metrics jsonb,p_cost numeric default 0) returns void
language plpgsql security invoker set search_path=public as $f$
declare k text;v jsonb;m jsonb;
begin
 select metrics into m from source_discovery_runs where id=p_run for update;
 for k,v in select * from jsonb_each(p_metrics) loop
   m=jsonb_set(m,array[k],to_jsonb(coalesce((m->>k)::numeric,0)+(v#>>'{}')::numeric));
 end loop;
 update source_discovery_runs set metrics=m,estimated_cost_usd=estimated_cost_usd+greatest(p_cost,0) where id=p_run;
end $f$;

-- Compare-and-set plus transaction prevents double approval, races and partial audit writes.
create or replace function public.source_review_candidate(p_actor uuid,p_candidate uuid,p_version integer,p_action text,p_target uuid,p_reason text,p_notes text,p_program jsonb,p_org jsonb) returns uuid
language plpgsql security invoker set search_path=public as $f$
declare c public.source_candidates;target public.funding_programs;pid uuid;oid uuid;newkey text;
begin
 perform public.source_require_actor(p_actor);
 select * into c from source_candidates where id=p_candidate for update;
 if not found then raise exception 'Candidate not found'; end if;
 if c.version<>p_version then raise exception 'Candidate changed; refresh before reviewing' using errcode='40001'; end if;
 if c.status in('APPROVED','MERGED','UPDATED','REJECTED') then raise exception 'Candidate already reviewed'; end if;
 if p_action not in('APPROVE_NEW','APPROVE_DISTINCT','MERGE','UPDATE','REJECT','INVESTIGATE') then raise exception 'Invalid action'; end if;
 if p_action in('REJECT','INVESTIGATE') and length(trim(coalesce(p_reason,'')))=0 then raise exception 'Reason code required'; end if;
 if p_action in('APPROVE_NEW','APPROVE_DISTINCT','UPDATE') and (not c.quality_ready or not(c.proposed->'evidence' ? 'program_name') or not(c.proposed->'evidence' ? 'funding_mechanism')) then raise exception 'Verify funding mechanism, program identity and state applicability first'; end if;
 if p_action='APPROVE_NEW' and c.duplicate_outcome='EXISTING' then raise exception 'Use update or merge for an existing program'; end if;
 if p_action in('MERGE','UPDATE','APPROVE_DISTINCT') then
   select * into target from funding_programs where id=p_target and superseded_by is null for update;
   if not found then raise exception 'Select a current existing program'; end if;
   if p_action='APPROVE_DISTINCT' and (target.organization_id is null or length(trim(coalesce(p_notes,'')))<20) then raise exception 'A resolved parent and a material distinction explanation are required'; end if;
 end if;
 if p_action in('APPROVE_NEW','APPROVE_DISTINCT') then
   newkey=p_program->>'identity_key';
   if coalesce(newkey,'')='' then raise exception 'Identity required'; end if;
   perform pg_advisory_xact_lock(hashtextextended(newkey,0));
   if exists(select 1 from funding_programs where identity_key=newkey) then raise exception 'Program already exists; update or merge it'; end if;
   if p_action='APPROVE_DISTINCT' then oid=target.organization_id;
   elsif p_org is not null and p_org->>'canonical_name' is not null then
     insert into funding_organizations(identity_key,canonical_name,normalized_name,website_domain,primary_url,first_verified_at,last_verified_at,provenance)
     values(p_org->>'identity_key',p_org->>'canonical_name',p_org->>'normalized_name',p_org->>'website_domain',p_org->>'primary_url',now(),now(),jsonb_build_object('candidate_id',c.id))
     on conflict(identity_key) do update set last_verified_at=excluded.last_verified_at returning id into oid;
   end if;
   insert into funding_programs(identity_key,organization_id,source_name,canonical_program_name,normalized_program_name,normalized_organization_name,source_url,normalized_url,website_domain,search_state,review_status,active)
   values(newkey,oid,c.source_name,p_program->>'canonical_program_name',p_program->>'normalized_program_name',p_program->>'normalized_organization_name',p_program->>'source_url',p_program->>'normalized_url',p_program->>'website_domain',c.state_code,'APPROVED',true) returning id into pid;
 elsif p_action in('MERGE','UPDATE') then pid=target.id;
 end if;
 if p_action='UPDATE' then
   newkey=p_program->>'identity_key';
   perform pg_advisory_xact_lock(hashtextextended(newkey,0));
   if exists(select 1 from funding_programs where identity_key=newkey and id<>pid) then raise exception 'Updated identity belongs to another program; merge instead'; end if;
   insert into source_aliases(program_id,alias_type,value,normalized_value,provenance) values(pid,'name',target.source_name,target.normalized_program_name,jsonb_build_object('candidate_id',c.id)) on conflict do nothing;
   insert into source_aliases(program_id,alias_type,value,normalized_value,provenance) values(pid,'url',target.source_url,target.normalized_url,jsonb_build_object('candidate_id',c.id)) on conflict do nothing;
   oid=target.organization_id;
   if oid is null and p_org is not null and p_org->>'canonical_name' is not null then
     insert into funding_organizations(identity_key,canonical_name,normalized_name,website_domain,primary_url,first_verified_at,last_verified_at,provenance)
     values(p_org->>'identity_key',p_org->>'canonical_name',p_org->>'normalized_name',p_org->>'website_domain',p_org->>'primary_url',now(),now(),jsonb_build_object('candidate_id',c.id))
     on conflict(identity_key) do update set last_verified_at=excluded.last_verified_at returning id into oid;
   end if;
   update funding_programs set identity_key=newkey,organization_id=oid,normalized_program_name=p_program->>'normalized_program_name',normalized_organization_name=p_program->>'normalized_organization_name',source_url=p_program->>'source_url',normalized_url=p_program->>'normalized_url',website_domain=p_program->>'website_domain',search_state=coalesce(search_state,c.state_code) where id=pid;
 end if;
 if pid is not null and p_action<>'MERGE' then
   update funding_programs set canonical_program_name=p_program->>'canonical_program_name', application_url=p_program->>'application_url',source_type=p_program->>'source_type',geography=p_program->>'geography',applicable_states=array(select jsonb_array_elements_text(coalesce(p_program->'applicable_states','[]'))),keywords=array(select jsonb_array_elements_text(coalesce(p_program->'keywords','[]'))),applicant_types=array(select jsonb_array_elements_text(coalesce(p_program->'applicant_types','[]'))),purpose=p_program->>'purpose',eligibility=p_program->>'eligibility',funding_mechanism=p_program->>'funding_mechanism',funding_pool=p_program->>'funding_pool',administering_unit=p_program->>'administering_unit',summary=p_program->>'summary',recurring_status=p_program->>'recurring_status',current_status=coalesce(p_program->>'current_status','UNKNOWN'),current_cycle_open=(p_program->>'current_cycle_open')::boolean,current_deadline=(p_program->>'current_deadline')::date,award_min=(p_program->>'award_min')::numeric,award_max=(p_program->>'award_max')::numeric,evidence=coalesce(p_program->'evidence','{}'),review_status='APPROVED',active=true,last_verified_at=now(),last_seen_at=now(),next_scan_at=now(),semantic_fingerprint=array(select jsonb_array_elements_text(coalesce(p_program->'semantic_fingerprint','[]'))) where id=pid;
 end if;
 if pid is not null then
   insert into source_aliases(program_id,alias_type,value,normalized_value,provenance) values(pid,'url',c.source_url,c.normalized_url,jsonb_build_object('candidate_id',c.id)) on conflict do nothing;
   if c.proposed->>'normalized_program_name' is not null then
     insert into source_aliases(program_id,alias_type,value,normalized_value,provenance) values(pid,'name',c.source_name,c.proposed->>'normalized_program_name',jsonb_build_object('candidate_id',c.id)) on conflict do nothing;
   end if;
 end if;
 insert into source_review_decisions(candidate_id,actor_id,action,reason_code,notes,target_program_id,before_snapshot,after_snapshot)
 values(c.id,p_actor,p_action,p_reason,coalesce(p_notes,''),pid,to_jsonb(c),jsonb_build_object('program',p_program,'target',pid));
 update source_candidates set status=case p_action when 'REJECT' then 'REJECTED' when 'INVESTIGATE' then 'INVESTIGATING' when 'MERGE' then 'MERGED' when 'UPDATE' then 'UPDATED' else 'APPROVED' end,matched_program_id=coalesce(pid,matched_program_id),reason_code=coalesce(p_reason,reason_code),version=version+1 where id=c.id;
 return pid;
end $f$;

create or replace function public.source_validate_florida(p_actor uuid,p_run uuid,p_validation jsonb) returns void
language plpgsql security invoker set search_path=public as $f$
declare r public.source_discovery_runs;
begin
 perform public.source_require_actor(p_actor);
 select * into r from source_discovery_runs where id=p_run for update;
 if not found or r.state_code<>'FL' or not r.clean_room or r.status<>'COMPLETED' then raise exception 'A completed independent Florida run is required'; end if;
 if not exists(select 1 from source_engine_settings where seed_completed_at is not null) then raise exception 'Complete corpus ingestion first'; end if;
 if coalesce((p_validation->>'false_positive_checks')::integer,0)<1 or coalesce((p_validation->>'false_negative_checks')::integer,0)<1 or length(trim(coalesce(p_validation->>'notes','')))<40 then raise exception 'Record false-positive and false-negative spot checks and validation findings'; end if;
 if not coalesce((p_validation->>'passed')::boolean,false) then raise exception 'Validation has not passed'; end if;
 update source_discovery_runs set validation=p_validation,validated_by=p_actor,validated_at=now() where id=p_run;
 update source_engine_settings set florida_validation_run_id=p_run,florida_validated_at=now(),florida_validated_by=p_actor,updated_at=now() where id=true;
 insert into source_review_decisions(actor_id,action,notes,before_snapshot,after_snapshot) values(p_actor,'FLORIDA_VALIDATION',p_validation->>'notes',to_jsonb(r),p_validation);
end $f$;

-- Postgres grants EXECUTE to PUBLIC by default. Explicitly restrict every new RPC.
do $block$
declare f record;
begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('source_require_actor','source_set_state','source_claim_job','source_reserve_usage','source_add_metrics','source_review_candidate','source_validate_florida') loop
   execute format('revoke all on function %s from public,anon,authenticated',f.signature);
   execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $block$;
commit;
