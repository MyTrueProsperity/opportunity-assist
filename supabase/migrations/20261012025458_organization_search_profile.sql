-- Atomic transfer + immutable provenance, using existing Organization fields.
begin;
create or replace function public.gf_transfer_search_profile(
 p_org uuid, p_actor uuid, p_brain_revision integer, p_before jsonb,
 p_patch jsonb, p_sources jsonb, p_preview_hash text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
 current_revision integer; current_profile jsonb; applied_profile jsonb; k text; v jsonb;
begin
 if not exists(select 1 from public.gf_members where org_id=p_org and user_id=p_actor and role='OWNER')
 or not exists(select 1 from public.org_memberships where org_id=p_org and user_id=p_actor) then
  raise exception 'Organization membership and executive Grant Factory approval required' using errcode='42501';
 end if;
 -- Same workspace lock as all fact/program/document writes. A private/revoked
 -- source cannot change between the server's authorization check and this save.
 select brain_revision into current_revision from public.gf_workspaces where org_id=p_org for update;
 if current_revision is distinct from p_brain_revision then
  raise exception 'Truth changed. Refresh the search profile review.' using errcode='40001';
 end if;
 select jsonb_build_object('service_areas',service_areas,'target_populations',target_populations,
  'programs',programs,'past_performance',past_performance,'keywords',keywords)
 into current_profile from public.organizations where id=p_org for update;
 if not found then raise exception 'Organization not found'; end if;
 if current_profile is distinct from p_before then
  raise exception 'Search profile changed. Refresh to preserve the latest edits.' using errcode='40001';
 end if;
 if jsonb_typeof(p_patch) is distinct from 'object' or jsonb_typeof(p_sources) is distinct from 'array'
 or jsonb_array_length(p_sources)>30 or p_preview_hash !~ '^[a-f0-9]{64}$' or p_preview_hash is null then
  raise exception 'Invalid reviewed transfer';
 end if;
 for k,v in select * from jsonb_each(p_patch) loop
  if k not in ('service_areas','target_populations','programs','past_performance','keywords') then
   raise exception 'Profile field is not transferable';
  end if;
  if k='keywords' then
   if jsonb_typeof(v)<>'array' then raise exception 'Keywords must be an array'; end if;
   if jsonb_array_length(v)>coalesce(jsonb_array_length(nullif(current_profile->'keywords','null'::jsonb)),0)+30
   or exists(select 1 from jsonb_array_elements(v) t where jsonb_typeof(t)<>'string'
    or (length(t#>>'{}')>80 and not coalesce(current_profile->'keywords','[]'::jsonb) @> jsonb_build_array(t))) then
    raise exception 'Invalid keywords';
   end if;
  elsif jsonb_typeof(v)<>'string' or length(v#>>'{}')>10000 then
   raise exception 'Invalid profile text';
  end if;
 end loop;
 if p_patch='{}'::jsonb then return jsonb_build_object('saved',false,'unchanged',true,'profile',current_profile); end if;
 if jsonb_array_length(p_sources)=0 then raise exception 'Reviewed sources required'; end if;
 -- These are server-generated public source references, never raw document text.
 -- Also require each reference to belong to this workspace at the locked revision.
 if exists(select 1 from jsonb_array_elements(p_sources) s where
  (s->>'kind'='fact' and not exists(select 1 from public.gf_facts f where f.org_id=p_org and f.id::text=s->>'id' and f.revision=(s->>'revision')::integer)) or
  (s->>'kind'='program' and not exists(select 1 from public.gf_programs p where p.org_id=p_org and p.id::text=s->>'id' and p.revision=(s->>'revision')::integer)) or
  coalesce(s->>'kind','') not in ('fact','program')) then raise exception 'Source is not in this organization'; end if;
 update public.organizations set
  service_areas=case when p_patch?'service_areas' then p_patch->>'service_areas' else service_areas end,
  target_populations=case when p_patch?'target_populations' then p_patch->>'target_populations' else target_populations end,
  programs=case when p_patch?'programs' then p_patch->>'programs' else programs end,
  past_performance=case when p_patch?'past_performance' then p_patch->>'past_performance' else past_performance end,
  keywords=case when p_patch?'keywords' then array(select jsonb_array_elements_text(p_patch->'keywords')) else keywords end
 where id=p_org;
 applied_profile=current_profile||p_patch;
 insert into public.gf_history(org_id,entity_id,entity_type,actor_id,event_type,revision,content)
 values(p_org,p_org,'organization_search_profile',p_actor,'SEARCH_PROFILE_TRANSFER',current_revision,
  jsonb_build_object('before',current_profile,'after',applied_profile,'patch',p_patch,'sources',p_sources,'preview_hash',p_preview_hash));
 return jsonb_build_object('saved',true,'profile',applied_profile);
end $$;
revoke all on function public.gf_transfer_search_profile(uuid,uuid,integer,jsonb,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.gf_transfer_search_profile(uuid,uuid,integer,jsonb,jsonb,jsonb,text) to service_role;
notify pgrst, 'reload schema';
commit;
