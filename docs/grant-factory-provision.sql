-- Trusted Supabase SQL administration only. Replace NULLs with verified existing IDs.
-- Grant Factory memberships are independent of the existing profile's primary organization.
-- Provision only explicitly approved people; do not move their primary profiles.
-- Read-only identification first; do not infer authority from display names.
-- select id, name from public.organizations;
-- select p.id, p.org_id, u.email from public.profiles p join auth.users u on u.id=p.id;
do $$
declare
 institute_org uuid := null;
 executive_profile uuid := null;
 manager_profile uuid := null;
begin
 if institute_org is null or executive_profile is null then
  raise exception 'Supply the verified Institute and executive IDs before provisioning';
 end if;
 if executive_profile=manager_profile then raise exception 'Use distinct verified accounts'; end if;
 if not exists(select 1 from public.organizations where id=institute_org)
 or not exists(select 1 from public.profiles where id=executive_profile)
 or (manager_profile is not null and not exists(select 1 from public.profiles where id=manager_profile)) then
  raise exception 'The organization and every supplied profile must already exist';
 end if;
 insert into public.gf_workspaces(org_id) values(institute_org) on conflict do nothing;
 insert into public.gf_members(org_id,user_id,role) values(institute_org,executive_profile,'OWNER')
 on conflict(org_id,user_id) do update set role=excluded.role;
 if manager_profile is not null then
  insert into public.gf_members(org_id,user_id,role) values(institute_org,manager_profile,'GRANT_MANAGER')
  on conflict(org_id,user_id) do update set role=excluded.role;
 end if;
end $$;
