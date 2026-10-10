-- Selective official-source deterministic promotion. Defaults off; no queued
-- work or public records are changed by installing this migration.
begin;
alter table public.source_engine_settings
 add column if not exists deterministic_promotion_enabled boolean not null default false,
 add column if not exists deterministic_promotion_not_before timestamptz,
 add column if not exists deterministic_promotion_daily_limit integer not null default 5 check(deterministic_promotion_daily_limit between 0 and 5),
 add column if not exists deterministic_promotion_sources jsonb not null default '[]' check(jsonb_typeof(deterministic_promotion_sources)='array' and jsonb_array_length(deterministic_promotion_sources)<=5);

create table if not exists public.source_deterministic_decisions(
 id uuid primary key default gen_random_uuid(),
 candidate_id uuid not null references public.source_candidates,
 candidate_version integer not null,
 policy_version text not null,
 observation_hash text,
 outcome text not null,
 reasons jsonb not null default '[]',
 program_id uuid references public.funding_programs,
 opportunity_id uuid references public.opportunities,
 created_at timestamptz not null default now(),
 unique(candidate_id,candidate_version,policy_version)
);
create index if not exists source_deterministic_daily_idx on public.source_deterministic_decisions(created_at);
-- Narrow new-identity checks and sighting verification; no registry-wide scans.
create index if not exists funding_program_promotion_identity_idx on public.funding_programs(normalized_program_name,normalized_organization_name,website_domain) where superseded_by is null;
create index if not exists source_sighting_candidate_idx on public.source_candidate_sightings(candidate_id);
alter table public.source_deterministic_decisions enable row level security;
revoke all on public.source_deterministic_decisions from public,anon,authenticated;
grant select,insert on public.source_deterministic_decisions to service_role;

create or replace function public.source_promote_deterministic(p_candidate uuid,p_version integer)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $f$
declare
 c public.source_candidates;e public.source_engine_settings;s public.source_state_settings;
 o jsonb;ev jsonb;pc public.source_page_cache;v jsonb;k text;reasons jsonb='[]';payload jsonb;org jsonb;
 fields text[]=array['program_name','funding_mechanism','geography','eligibility','current_cycle_open','current_deadline'];
 fingerprint text;keyvalue text;observed timestamptz;pid uuid;oid uuid;result text;existing public.source_deterministic_decisions;decision_now timestamptz;
begin
 -- Share the existing identity transaction lock, and hold the setting row lock
 -- through publication. Concurrent workers cannot overrun the daily ceiling.
 perform pg_advisory_xact_lock(hashtextextended('source-automatic-approval-v1',0));
 select * into e from source_engine_settings where id=true for update;
 decision_now=clock_timestamp();
 if not found or not e.engine_enabled or not e.automatic_approval_enabled or not e.deterministic_promotion_enabled
 or e.deterministic_promotion_not_before is null then return jsonb_build_object('outcome','DISABLED');end if;
 select * into c from source_candidates where id=p_candidate for update;
 if not found then raise exception 'Candidate not found';end if;
 if c.version<>p_version then return jsonb_build_object('outcome','STALE');end if;
 if c.status<>'PENDING' or exists(select 1 from source_review_decisions where candidate_id=c.id)
 then return jsonb_build_object('outcome','HUMAN_OR_FINAL_DECISION');end if;
 select * into existing from source_deterministic_decisions
 where candidate_id=c.id and candidate_version=c.version and policy_version='deterministic-official-v1';
 if found then return jsonb_build_object('outcome',existing.outcome,'reasons',existing.reasons,'program_id',existing.program_id,'opportunity_id',existing.opportunity_id);end if;
 if (select count(*) from source_deterministic_decisions where created_at>=date_trunc('day',decision_now at time zone 'UTC') at time zone 'UTC')>=e.deterministic_promotion_daily_limit
 then return jsonb_build_object('outcome','DAILY_LIMIT');end if;
 select * into s from source_state_settings where state_code=c.state_code for share;
 if not found or not(s.discovery_enabled or s.monitoring_enabled) or not s.publication_enabled
 or(c.state_code<>'FL' and e.florida_validated_at is null) then reasons=reasons||'"STATE_DISABLED"'::jsonb;end if;
 o=c.proposed->'deterministic_observation';ev=c.proposed->'evidence';
 if c.discovery_method<>'ZERO_TOKEN_HARVEST' or not c.quality_ready or c.proposed ? 'submitted_evidence'
 or o->>'policy' is distinct from 'deterministic-official-v1'
 or o->>'provenance' is distinct from 'INDEPENDENT_FETCH'
 or o->>'synthetic' is distinct from 'false' or c.proposed->>'synthetic' is distinct from 'false'
 or o->>'http_status' is distinct from '200' then reasons=reasons||'"INDEPENDENT_FETCH_REQUIRED"'::jsonb;end if;
 if not exists(select 1 from jsonb_array_elements(e.deterministic_promotion_sources) a
 where a->>'kind'='official-page' and a->>'url'=c.source_url and a->>'state'=c.state_code)
 or c.source_url!~'^https://' or c.source_url~'[#@]' or o->>'url' is distinct from c.source_url
 or c.proposed->>'source_url' is distinct from c.source_url
 or c.proposed->>'target_state' is distinct from c.state_code
 then reasons=reasons||'"OFFICIAL_SOURCE_MISMATCH"'::jsonb;end if;
 begin observed=(o->>'observed_at')::timestamptz;
 exception when others then observed=null;end;
 if observed is null or observed<decision_now-interval '24 hours' or observed>decision_now
 or observed<e.deterministic_promotion_not_before or c.first_seen_at<e.deterministic_promotion_not_before
 or c.last_verified_at is distinct from observed then reasons=reasons||'"STALE_OBSERVATION"'::jsonb;end if;
 if coalesce(length(o->>'text'),0)=0 or length(o->>'text')>60000
 or o->>'text_hash' is distinct from encode(sha256(convert_to(o->>'text','UTF8')),'hex')
 or coalesce(o->>'page_hash','')!~'^[a-f0-9]{64}$' then reasons=reasons||'"SOURCE_HASH_MISMATCH"'::jsonb;end if;
 select * into pc from source_page_cache where normalized_url=c.normalized_url for share;
 if not found or pc.page_hash is distinct from o->>'page_hash' or pc.resolved_url is distinct from c.source_url
 or pc.fetched_at is distinct from observed
 or not exists(select 1 from jsonb_array_elements(pc.extracted->'programs') p
 where p=c.proposed and p->'deterministic_observation'=o)
 then reasons=reasons||'"CACHE_OBSERVATION_MISMATCH"'::jsonb;end if;
 if c.version<>2 or c.duplicate_outcome<>'NEW' or c.matched_program_id is not null
 or c.duplicate_matches<>'[]'::jsonb or jsonb_array_length(coalesce(c.proposed->'material_changes','[]'))>0
 or (select count(*) from (select 1 from source_candidate_sightings where candidate_id=c.id limit 2) sightings)<>1
 or not exists(select 1 from source_candidate_sightings where candidate_id=c.id
 and provenance->'deterministic_observation'=o)
 then reasons=reasons||'"NEW_IDENTITY_REQUIRED"'::jsonb;end if;
 if exists(select 1 from jsonb_array_elements_text(coalesce(c.proposed->'review_reasons','[]')) x where x<>'HUMAN_REVIEW')
 or c.reason_code is distinct from 'HUMAN_REVIEW'
 or c.proposed->'deterministic_assessment'->>'outcome' is distinct from 'ELIGIBLE'
 then reasons=reasons||'"UNRESOLVED_REVIEW_REASONS"'::jsonb;end if;
 foreach k in array fields loop
  v=ev->k;
  if coalesce(v->>'quote','')='' or length(v->>'quote')>5000 or v->>'url' is distinct from o->>'url'
  or v->>'method' is distinct from 'deterministic'
  or position(v->>'quote' in o->>'text')=0 or o->>'text' is null
  then reasons=reasons||to_jsonb('UNGROUNDED_'||upper(k));end if;
  if k in('program_name','funding_mechanism','geography','eligibility') and
  (coalesce(c.proposed->>k,'')='' or position(c.proposed->>k in v->>'quote')=0 or v->>'quote' is null)
  then reasons=reasons||to_jsonb('VALUE_MISMATCH_'||upper(k));end if;
 end loop;
 select string_agg(q.k||E'\n'||coalesce(ev->q.k->>'quote','')||E'\n'||coalesce(ev->q.k->>'url',''),E'\n' order by q.n)
 into fingerprint from unnest(fields) with ordinality q(k,n);
 if o->>'evidence_hash' is distinct from encode(sha256(convert_to(fingerprint,'UTF8')),'hex')
 then reasons=reasons||'"EVIDENCE_HASH_MISMATCH"'::jsonb;end if;
 if not coalesce(c.proposed->'applicable_states' ? c.state_code,false)
 or c.proposed->>'geography' not in(s.state_name,'State of '||s.state_name)
 then reasons=reasons||'"GEOGRAPHY_COMPLEX_REVIEW"'::jsonb;end if;
 if c.proposed->>'current_cycle_open' is distinct from 'true'
 or coalesce(ev->'current_cycle_open'->>'quote','')!~*'^(applications? (are )?(now )?open|now accepting applications)[.!]?$'
 or lower(coalesce(c.proposed->>'funding_mechanism','')) not in('grant','grants')
 then reasons=reasons||'"OPEN_GRANT_REQUIRED"'::jsonb;end if;
 begin
  if (c.proposed->>'current_deadline')::date<=(decision_now at time zone 'UTC')::date
  or c.proposed->>'current_deadline'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  or position(c.proposed->>'current_deadline' in ev->'current_deadline'->>'quote')=0
  then reasons=reasons||'"FUTURE_EXPLICIT_DEADLINE_REQUIRED"'::jsonb;end if;
 exception when others then reasons=reasons||'"FUTURE_EXPLICIT_DEADLINE_REQUIRED"'::jsonb;end;
 if c.proposed->>'current_deadline' is null then reasons=reasons||'"FUTURE_EXPLICIT_DEADLINE_REQUIRED"'::jsonb;end if;
 foreach k in array array['award_min','award_max'] loop
  if c.proposed->>k is not null and (coalesce(ev->k->>'quote','')='' or ev->k->>'url' is distinct from o->>'url'
  or position(ev->k->>'quote' in o->>'text')=0)
  then reasons=reasons||to_jsonb('UNGROUNDED_'||upper(k));end if;
 end loop;
 if c.proposed->>'application_url' is not null and c.proposed->>'application_url'<>c.source_url
 then reasons=reasons||'"APPLICATION_URL_REVIEW"'::jsonb;end if;
 keyvalue=encode(sha256(convert_to(case when coalesce(c.proposed->>'normalized_organization_name','')<>'' then
 'organization|'||(c.proposed->>'website_domain')||'|'||(c.proposed->>'normalized_organization_name')||'|'||(c.proposed->>'normalized_program_name')
 else 'source|'||c.normalized_url||'|'||(c.proposed->>'normalized_program_name') end,'UTF8')),'hex');
 if exists(select 1 from funding_programs p where p.superseded_by is null and
 (p.identity_key=keyvalue or p.normalized_url=c.normalized_url
 or(p.normalized_program_name=c.proposed->>'normalized_program_name' and p.website_domain=c.proposed->>'website_domain')
 or(p.normalized_program_name=c.proposed->>'normalized_program_name' and coalesce(p.normalized_organization_name,'')<>'' and p.normalized_organization_name=c.proposed->>'normalized_organization_name')))
 or exists(select 1 from source_aliases where alias_type='url' and normalized_value=c.normalized_url)
 then reasons=reasons||'"IDENTITY_REVIEW_REQUIRED"'::jsonb;end if;
 result=case when jsonb_array_length(reasons)=0 then 'PROMOTED' else 'REVIEW_REQUIRED' end;
 if result='PROMOTED' then
  -- No caller-controlled publication payload: all fields come from the locked row.
  payload=c.proposed||jsonb_build_object('identity_key',keyvalue,'canonical_program_name',c.proposed->>'program_name');
  if coalesce(c.proposed->>'organization_name','')<>'' then
   org=jsonb_build_object('identity_key',encode(sha256(convert_to((c.proposed->>'website_domain')||'|'||(c.proposed->>'normalized_organization_name'),'UTF8')),'hex'),
   'canonical_name',c.proposed->>'organization_name','normalized_name',c.proposed->>'normalized_organization_name','website_domain',c.proposed->>'website_domain','primary_url','https://'||(c.proposed->>'website_domain'));
  end if;
  begin
  pid=source_apply_review(null,c.id,c.version,'APPROVE_NEW',null,'DETERMINISTIC_OFFICIAL',
   'Current complete official evidence; deterministic promotion, not human review.',payload,org,'AUTOMATIC');
  oid=source_publish_cycle(pid,c.state_code,'year:'||left(c.proposed->>'current_deadline',4),
   jsonb_build_object('title',c.proposed->>'program_name','source_url',c.source_url,
   'category',case when c.proposed->>'source_type'='GOVERNMENT_GRANT' then 'Government Grant' else 'Foundation Grant' end,
   'deadline_mentioned',ev->'current_deadline'->>'quote','deadline_verified',true,
   'amount_mentioned',ev->'award_max'->>'quote','amount_verified',ev ? 'award_max',
   'funding_amount_label',case when c.proposed->>'award_max' is not null then 'Up to $'||(c.proposed->>'award_max') else null end),ev);
  if oid is null then raise exception 'Publication failed; deterministic approval rolled back';end if;
  update source_review_decisions set policy_version='deterministic-official-v1' where candidate_id=c.id and policy_version='automatic-v1';
  update funding_programs set next_scan_at=decision_now+interval '7 days',provenance=provenance||jsonb_build_object('approval_policy','deterministic-official-v1') where id=pid;
  exception when others then
   -- Roll back the approval/publication subtransaction but retain this attempt
   -- outside it, so even publication failures consume the daily allowance.
   result='FAILED';reasons=jsonb_build_array('DETERMINISTIC_PUBLICATION_FAILED');pid=null;oid=null;
   update source_candidates set automatic_approval_error='Deterministic publication failed; manual review required',
    reason_code='DETERMINISTIC_PUBLICATION_FAILED' where id=c.id;
  end;
 end if;
 insert into source_deterministic_decisions(candidate_id,candidate_version,policy_version,observation_hash,outcome,reasons,program_id,opportunity_id,created_at)
 values(c.id,c.version,'deterministic-official-v1',o->>'evidence_hash',result,reasons,pid,oid,decision_now);
 if result='REVIEW_REQUIRED' then update source_candidates set reason_code='DETERMINISTIC_REVIEW_REQUIRED',reason='Deterministic check: '||reasons::text where id=c.id;end if;
 return jsonb_build_object('outcome',result,'reasons',reasons,'program_id',pid,'opportunity_id',oid);
end $f$;
revoke all on function public.source_promote_deterministic(uuid,integer) from public,anon,authenticated;
grant execute on function public.source_promote_deterministic(uuid,integer) to service_role;

-- Administrator changes are audited; this does not enqueue any work.
create or replace function public.source_configure_deterministic(p_actor uuid,p_enabled boolean,p_sources jsonb,p_daily_limit integer,p_confirmation text default '')
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $f$
declare e public.source_engine_settings;a jsonb;
begin
 perform source_require_actor(p_actor);
 if p_enabled is null or p_daily_limit is null or p_daily_limit not between 0 and 5
 or jsonb_typeof(p_sources) is distinct from 'array' or jsonb_array_length(p_sources)>5 then raise exception 'Invalid deterministic promotion settings';end if;
 for a in select value from jsonb_array_elements(p_sources) loop
  if a->>'kind' is distinct from 'official-page' or coalesce(a->>'url','')!~'^https://[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(/[^#]*)?$'
  or a->>'url'~'[@#]' or not exists(select 1 from source_state_settings where state_code= a->>'state')
  then raise exception 'Use reviewed exact official HTTPS page URLs and valid states';end if;
 end loop;
 if (select count(distinct x->>'url') from jsonb_array_elements(p_sources) x)<>jsonb_array_length(p_sources)
 then raise exception 'Repeated source URLs are not allowed';end if;
 if p_enabled and (jsonb_array_length(p_sources)=0 or p_daily_limit=0 or p_confirmation is distinct from 'ENABLE_DETERMINISTIC_PROMOTION_AFTER_OFFICIAL_PILOT')
 then raise exception 'Reviewed official-source pilot and explicit activation confirmation required';end if;
 select * into e from source_engine_settings where id=true for update;
 if p_enabled and(not e.engine_enabled or not e.automatic_approval_enabled)
 then raise exception 'Existing engine and automatic-approval gates must be enabled first';end if;
 update source_engine_settings set deterministic_promotion_enabled=p_enabled,
 deterministic_promotion_sources=p_sources,deterministic_promotion_daily_limit=p_daily_limit,
 deterministic_promotion_not_before=case when p_enabled then clock_timestamp() else null end,updated_at=now() where id=true;
 insert into source_review_decisions(actor_id,action,notes,before_snapshot,after_snapshot,policy_version)
 values(p_actor,'DETERMINISTIC_CONFIGURATION','Explicit administrator configuration; no backlog processing.',
 jsonb_build_object('enabled',e.deterministic_promotion_enabled,'sources',e.deterministic_promotion_sources,'daily_limit',e.deterministic_promotion_daily_limit),
 jsonb_build_object('enabled',p_enabled,'sources',p_sources,'daily_limit',p_daily_limit),'deterministic-official-v1');
 return jsonb_build_object('enabled',p_enabled,'sources',p_sources,'daily_limit',p_daily_limit);
end $f$;
revoke all on function public.source_configure_deterministic(uuid,boolean,jsonb,integer,text) from public,anon,authenticated;
grant execute on function public.source_configure_deterministic(uuid,boolean,jsonb,integer,text) to service_role;
commit;
