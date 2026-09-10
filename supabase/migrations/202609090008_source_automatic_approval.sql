begin;
-- Owner-requested automatic source decisions. State and publication gates remain.
alter table public.source_engine_settings add column if not exists automatic_approval_enabled boolean not null default true;
alter table public.source_review_decisions alter column actor_id drop not null;
alter table public.source_review_decisions add column if not exists decision_origin text not null default 'MANUAL' check(decision_origin in('MANUAL','AUTOMATIC'));
alter table public.source_review_decisions add column if not exists policy_version text;
alter table public.source_candidates add column if not exists next_verification_at timestamptz not null default now();

create or replace function public.source_apply_review(p_actor uuid,p_candidate uuid,p_version integer,p_action text,p_target uuid,p_reason text,p_notes text,p_program jsonb,p_org jsonb,p_origin text default 'MANUAL') returns uuid
language plpgsql security invoker set search_path=public as $f$
declare c public.source_candidates;target public.funding_programs;pid uuid;oid uuid;newkey text;
begin
 if p_origin not in('MANUAL','AUTOMATIC') then raise exception 'Invalid decision origin'; end if;
 if p_origin='MANUAL' then perform public.source_require_actor(p_actor); end if;
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
 insert into source_review_decisions(candidate_id,actor_id,action,reason_code,notes,target_program_id,before_snapshot,after_snapshot,decision_origin,policy_version)
 values(c.id,p_actor,p_action,p_reason,coalesce(p_notes,''),pid,to_jsonb(c),jsonb_build_object('program',p_program,'target',pid),p_origin,case when p_origin='AUTOMATIC' then 'automatic-v1' end);
 update source_candidates set status=case p_action when 'REJECT' then 'REJECTED' when 'INVESTIGATE' then 'INVESTIGATING' when 'MERGE' then 'MERGED' when 'UPDATE' then 'UPDATED' else 'APPROVED' end,matched_program_id=coalesce(pid,matched_program_id),reason_code=coalesce(p_reason,reason_code),version=version+1 where id=c.id;
 return pid;
end $f$;

-- Retain the human API and its administrator check. Automation is recorded as
-- the system, never as if an administrator individually reviewed the record.
create or replace function public.source_review_candidate(p_actor uuid,p_candidate uuid,p_version integer,p_action text,p_target uuid,p_reason text,p_notes text,p_program jsonb,p_org jsonb) returns uuid
language plpgsql security invoker set search_path=public as $f$
begin
 perform source_require_actor(p_actor);
 return source_apply_review(p_actor,p_candidate,p_version,p_action,p_target,p_reason,p_notes,p_program,p_org,'MANUAL');
end $f$;

create or replace function public.source_automatic_candidates(p_limit integer default 10) returns setof public.source_candidates
language sql security invoker set search_path=public as $f$
 select c.* from source_candidates c
 join source_state_settings s on s.state_code=c.state_code
 cross join source_engine_settings e
 where e.id and e.engine_enabled and e.automatic_approval_enabled
 and (s.discovery_enabled or s.monitoring_enabled) and (s.state_code='FL' or e.florida_validated_at is not null)
 and c.status in('PENDING','MATCHED','INVESTIGATING') and c.quality_ready and c.last_verified_at>=now()-interval '7 days'
 and coalesce(c.proposed->'evidence' ?& array['program_name','funding_mechanism','applicable_states'],false)
 and coalesce(c.proposed->'applicable_states' ? c.state_code,false)
 and coalesce(c.proposed->>'program_name','')<>'' and coalesce(c.proposed->>'funding_mechanism','')<>'' and c.duplicate_outcome<>'REJECT'
 and not exists(select 1 from source_review_decisions d where d.candidate_id=c.id and d.decision_origin='MANUAL')
 order by c.first_seen_at,c.id limit greatest(0,least(p_limit,25));
$f$;

create or replace function public.source_due_verifications(p_state text,p_limit integer default 2) returns setof public.source_candidates
language sql security invoker set search_path=public as $f$
 select c.* from source_candidates c join source_state_settings s on s.state_code=c.state_code cross join source_engine_settings e
 where e.id and e.engine_enabled and e.automatic_approval_enabled
 and (s.discovery_enabled or s.monitoring_enabled) and (s.state_code='FL' or e.florida_validated_at is not null)
 and c.state_code=p_state and c.status in('PENDING','INVESTIGATING','MATCHED') and not(c.proposed ? 'resolved_candidate_ids')
 and c.next_verification_at<=now() and coalesce(c.last_verified_at,c.first_seen_at)<now()-interval '7 days'
 and not exists(select 1 from source_review_decisions d where d.candidate_id=c.id and d.decision_origin='MANUAL')
 and not exists(select 1 from source_jobs j where j.state_code=c.state_code and j.status in('QUEUED','RUNNING','PAUSED') and (j.payload->>'candidate_id'=c.id::text or j.payload->>'url'=c.source_url))
 order by c.next_verification_at,c.first_seen_at,c.id limit greatest(0,least(p_limit,10));
$f$;

create or replace function public.source_automatically_approve(p_candidate uuid,p_version integer,p_program jsonb,p_org jsonb,p_publication jsonb) returns jsonb
language plpgsql security invoker set search_path=public as $f$
declare c public.source_candidates;e public.source_engine_settings;s public.source_state_settings;target public.funding_programs;pid uuid;oid uuid;decision text;note text;
begin
 select * into e from source_engine_settings where id=true;
 if not e.engine_enabled or not e.automatic_approval_enabled then return jsonb_build_object('outcome','DISABLED'); end if;
 -- Serialize automatic matching and creation so two concurrent observations
 -- cannot both approve separate records for the same confirmed mechanism.
 perform pg_advisory_xact_lock(hashtextextended('source-automatic-approval-v1',0));
 select * into c from source_candidates where id=p_candidate for update;
 if not found then raise exception 'Candidate not found'; end if;
 if c.version<>p_version then return jsonb_build_object('outcome','STALE'); end if;
 if c.status in('APPROVED','MERGED','UPDATED','REJECTED') then return jsonb_build_object('outcome','ALREADY_DECIDED','program_id',c.matched_program_id); end if;
 if exists(select 1 from source_review_decisions where candidate_id=c.id and decision_origin='MANUAL') then return jsonb_build_object('outcome','HUMAN_DECISION'); end if;
 select * into s from source_state_settings where state_code=c.state_code;
 if not found or not(s.discovery_enabled or s.monitoring_enabled) or (c.state_code<>'FL' and e.florida_validated_at is null) then return jsonb_build_object('outcome','STATE_DISABLED'); end if;
 if not c.quality_ready or c.last_verified_at is null or c.last_verified_at<now()-interval '7 days'
 or coalesce(c.proposed->>'program_name','')='' or coalesce(c.proposed->>'funding_mechanism','')=''
 or not coalesce(c.proposed->'evidence' ?& array['program_name','funding_mechanism','applicable_states'],false)
 or not coalesce(c.proposed->'applicable_states' ? c.state_code,false)
 or c.duplicate_outcome='REJECT' then return jsonb_build_object('outcome','AWAITING_EVIDENCE'); end if;
 if p_program->>'normalized_program_name' is distinct from c.proposed->>'normalized_program_name'
 or p_program->>'normalized_url' is distinct from c.normalized_url then raise exception 'Automatic payload does not match verified candidate'; end if;
 -- Only deterministic identity evidence can suppress a new record. Shared
 -- domains, similar names, semantic scores and model opinions are insufficient.
 select p.* into target from funding_programs p
 where p.superseded_by is null and (
   p.identity_key=p_program->>'identity_key'
   or (p.normalized_program_name=p_program->>'normalized_program_name' and (
     p.normalized_url=c.normalized_url
     or (coalesce(p.normalized_organization_name,'')<>'' and p.normalized_organization_name=p_program->>'normalized_organization_name' and p.website_domain=p_program->>'website_domain')
     or exists(select 1 from source_aliases a where a.program_id=p.id and a.alias_type='url' and a.normalized_value=c.normalized_url)
   ))
 )
 order by (p.identity_key=p_program->>'identity_key') desc,(p.review_status='APPROVED') desc,
   exists(select 1 from opportunities o where o.funding_program_id=p.id) desc,p.first_seen_at,p.id
 limit 1 for update;
 if found then
   if target.review_status='APPROVED' then decision='MERGE';
   else decision='UPDATE'; end if;
   note='Confirmed duplicate: linked to the existing program without creating another record.';
 else
   -- A stale advisory match must not force a duplicate decision. The registry
   -- above is authoritative at this transaction, including concurrent approvals.
   if c.duplicate_outcome='EXISTING' then
     update source_candidates set duplicate_outcome='NEW',matched_program_id=null where id=c.id;
   end if;
   decision='APPROVE_NEW';
   note='Automatically approved verified funding source. Possible similarities do not block approval.';
 end if;
 pid=source_apply_review(null,c.id,c.version,decision,target.id,null,note,p_program,p_org,'AUTOMATIC');
 if decision<>'MERGE' then
   update funding_programs set next_scan_at=now()+interval '7 days',provenance=provenance||jsonb_build_object('approval_policy','automatic-v1') where id=pid;
   oid=source_publish_cycle(pid,c.state_code,p_publication->>'cycle_key',p_publication->'opportunity',p_program->'evidence');
 end if;
 return jsonb_build_object('outcome',decision,'program_id',pid,'opportunity_id',oid);
end $f$;

do $block$
declare f record;
begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('source_apply_review','source_review_candidate','source_automatic_candidates','source_automatically_approve','source_due_verifications') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $block$;
commit;
