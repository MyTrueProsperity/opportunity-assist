-- Only the authenticated Grant Factory server may retrieve this private corpus.
-- A package must be active and explicitly assigned to the selected workspace.
create table research_evidence.package_workspaces (
  package_version text not null references research_evidence.packages on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  primary key (package_version, org_id)
);
create table research_evidence.document_parts (
  package_version text not null references research_evidence.packages on delete cascade,
  document_path text not null check (document_path = 'master_research_volume.md'),
  part_number integer not null check (part_number >= 0),
  content text not null,
  primary key (package_version, document_path, part_number)
);
alter table research_evidence.package_workspaces enable row level security;
alter table research_evidence.document_parts enable row level security;
revoke all on research_evidence.package_workspaces, research_evidence.document_parts from public, anon, authenticated;
grant usage on schema research_evidence to service_role;
grant select on all tables in schema research_evidence to service_role;
grant select on public.gf_members to service_role;

create index research_sections_search on research_evidence.research_sections
  using gin (to_tsvector('english', coalesce(title,'') || ' ' || content_markdown));

create function research_evidence.accessible_packages(p_org uuid, p_actor uuid)
returns setof research_evidence.packages language sql stable security invoker set search_path = '' as $$
  select p.* from research_evidence.packages p
  join research_evidence.package_workspaces w using (package_version)
  where p.status = 'active' and w.org_id = p_org
    and exists (select 1 from public.gf_members m where m.org_id=p_org and m.user_id=p_actor)
$$;
revoke all on function research_evidence.accessible_packages(uuid,uuid) from public,anon,authenticated;
grant execute on function research_evidence.accessible_packages(uuid,uuid) to service_role;

create function public.gf_research_bundle(p_org uuid, p_actor uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with packages as materialized (select * from research_evidence.accessible_packages(p_org,p_actor))
  select jsonb_build_object(
    'packages',coalesce((select jsonb_agg(jsonb_build_object('package_version',package_version,'status',status,'activated_at',activated_at,'metadata',metadata) order by package_version) from packages),'[]'::jsonb),
    'records',coalesce((select jsonb_agg(e.payload || jsonb_build_object(
      'record_id',e.record_id,'package_version',e.package_version,'verification_status',e.verification_status,
      'last_verified',e.last_verified,'review_before_external_use',e.review_before_external_use,'qa_flags',e.qa_flags,
      'external_use_status',case when e.verification_status='PRIMARY_VERIFIED' and e.last_verified is not null and not e.review_before_external_use then 'VERIFIED' else 'NEEDS_REVIEW' end
    ) order by e.package_version,e.record_id) from research_evidence.evidence_records e join packages p using(package_version)),'[]'::jsonb),
    'packets',coalesce((select jsonb_agg(f.payload order by f.package_version,f.packet_id) from research_evidence.funder_packets f join packages p using(package_version)),'[]'::jsonb),
    'statistics',coalesce((select jsonb_agg(s.payload || jsonb_build_object('external_use_status',case when e.verification_status='PRIMARY_VERIFIED' and e.last_verified is not null and not e.review_before_external_use and not s.review_before_external_use then 'VERIFIED' else 'NEEDS_REVIEW' end) order by s.package_version,s.stat_id) from research_evidence.statistics s join packages p using(package_version) join research_evidence.evidence_records e using(package_version,record_id)),'[]'::jsonb),
    'rules',coalesce((select jsonb_agg(r.payload order by r.package_version,r.rule_id) from research_evidence.claim_rules r join packages p using(package_version)),'[]'::jsonb),
    'aliases',coalesce((select jsonb_agg(to_jsonb(a) order by a.package_version,a.legacy_record_id) from research_evidence.record_aliases a join packages p using(package_version)),'[]'::jsonb)
  )
$$;

create function public.gf_research_search(p_org uuid, p_actor uuid, p_query text default '', p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with packages as materialized (select * from research_evidence.accessible_packages(p_org,p_actor)),
  q as (select websearch_to_tsquery('english',left(p_query,300)) terms),
  matches as materialized (
    select s.*,ts_rank(to_tsvector('english',coalesce(s.title,'') || ' ' || s.content_markdown),q.terms) rank
    from research_evidence.research_sections s join packages p using(package_version) cross join q
    where btrim(p_query)<>'' and to_tsvector('english',coalesce(s.title,'') || ' ' || s.content_markdown) @@ q.terms
  ), page as (select * from matches order by rank desc,package_version,section_id limit 20 offset greatest(0,least(coalesce(p_offset,0),10000)))
  select jsonb_build_object(
    'retrieval_policy','background_only; canonical evidence and claim rules govern external claims',
    'total',(select count(*) from matches),
    'offset',greatest(0,least(coalesce(p_offset,0),10000)),
    'sections',coalesce((select jsonb_agg(payload order by rank desc,package_version,section_id) from page),'[]'::jsonb),
    'sources',coalesce((select jsonb_agg(l.payload order by l.package_version,l.source_url) from research_evidence.source_library l join packages p using(package_version) where exists(select 1 from page s where s.package_version=l.package_version and l.source_url=any(s.source_urls))),'[]'::jsonb)
  )
$$;

create function public.gf_research_document(p_org uuid, p_actor uuid, p_package text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('package_version',d.package_version,'filename',d.document_path,
    'retrieval_policy','background_only; canonical evidence and claim rules govern external claims',
    'content',string_agg(d.content,'' order by d.part_number))
  from research_evidence.document_parts d
  join research_evidence.accessible_packages(p_org,p_actor) p using(package_version)
  where d.package_version=p_package and d.document_path='master_research_volume.md'
  group by d.package_version,d.document_path
$$;
revoke all on function public.gf_research_bundle(uuid,uuid), public.gf_research_search(uuid,uuid,text,integer), public.gf_research_document(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.gf_research_bundle(uuid,uuid), public.gf_research_search(uuid,uuid,text,integer), public.gf_research_document(uuid,uuid,text) to service_role;
notify pgrst, 'reload schema';
