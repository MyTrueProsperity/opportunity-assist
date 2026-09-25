-- Research summary for Grant Factory startup.
--
-- Grant Factory's bootstrap needs to know which research packages the
-- workspace can use and how many records, packets, statistics and claim rules
-- they hold. It does not need the records themselves; those are loaded on
-- demand. This function returns only package identities and counts, so its
-- size grows with the number of packages, not the number of records.
--
-- Authorization is identical to gf_research_bundle: it reads through
-- research_evidence.accessible_packages (active packages explicitly assigned to
-- the workspace, for a Grant Factory member only) and only service_role may
-- execute it. The "verified" count uses the same rule as the bundle's
-- external_use_status. No data is changed.
create or replace function public.gf_research_summary(p_org uuid, p_actor uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with packages as materialized (select * from research_evidence.accessible_packages(p_org,p_actor))
  select jsonb_build_object(
    'packages',coalesce((select jsonb_agg(jsonb_build_object('package_version',package_version,'status',status,'activated_at',activated_at) order by package_version) from packages),'[]'::jsonb),
    'counts',jsonb_build_object(
      'records',(select count(*) from research_evidence.evidence_records e join packages p using(package_version)),
      'verified',(select count(*) from research_evidence.evidence_records e join packages p using(package_version)
                  where e.verification_status='PRIMARY_VERIFIED' and e.last_verified is not null and not e.review_before_external_use),
      'packets',(select count(*) from research_evidence.funder_packets f join packages p using(package_version)),
      'statistics',(select count(*) from research_evidence.statistics s join packages p using(package_version)
                    join research_evidence.evidence_records e using(package_version,record_id)),
      'rules',(select count(*) from research_evidence.claim_rules r join packages p using(package_version))
    )
  )
$$;
revoke all on function public.gf_research_summary(uuid,uuid) from public,anon,authenticated;
grant execute on function public.gf_research_summary(uuid,uuid) to service_role;
notify pgrst, 'reload schema';
