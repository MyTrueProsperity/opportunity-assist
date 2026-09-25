-- Organization switching for Opportunity Assist.
--
-- profiles.org_id stays the ACTIVE organization, so every existing policy that
-- uses current_org_id() (fit_scores, pipeline, contracts, alerts, pursue
-- decisions, activity, organizations) keeps working unchanged and only ever
-- sees one organization at a time.
--
-- What is new:
--   * org_memberships records which organizations a user is explicitly
--     authorized for. Existing profile assignments are backfilled.
--   * A trigger on profiles only lets org_id point at an organization the user
--     belongs to. This also closes a gap where profiles_update_own let any
--     signed-in user set org_id to any organization id.
--   * A user may claim an organization they created within the last day that
--     has no members yet (the onboarding and guest flows), which records them
--     as OWNER. Older organizations always need an explicit membership.
--   * A creator can read an organization they created in the last day, so the
--     onboarding insert-and-return works before the profile points at it.
--   * my_organizations() lists the caller's organizations for the switcher;
--     set_active_org() switches, relying on RLS plus the trigger.
-- Membership rows are written only by the trigger or by service-role SQL.

create table if not exists public.org_memberships (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'MEMBER' check (role in ('OWNER', 'MEMBER')),
  granted_note text,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_memberships_user_idx on public.org_memberships (user_id);
alter table public.org_memberships enable row level security;
revoke all on public.org_memberships from public, anon, authenticated;
grant select on public.org_memberships to authenticated;
drop policy if exists org_memberships_select_own on public.org_memberships;
create policy org_memberships_select_own on public.org_memberships
  for select to authenticated using (user_id = (select auth.uid()));

insert into public.org_memberships (org_id, user_id, role, granted_note)
select p.org_id, p.id, case when o.created_by = p.id then 'OWNER' else 'MEMBER' end, 'Backfilled from profiles.org_id'
from public.profiles p join public.organizations o on o.id = p.org_id
on conflict do nothing;

create or replace function public.guard_profile_active_org() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.org_id is not distinct from old.org_id then return new; end if;
  -- Service-role and maintenance SQL run without a signed-in user.
  if auth.uid() is null then return new; end if;
  if auth.uid() is distinct from new.id then
    raise exception 'A profile can only be changed by its owner' using errcode = '42501';
  end if;
  if exists (select 1 from public.org_memberships m where m.org_id = new.org_id and m.user_id = new.id) then
    return new;
  end if;
  if exists (select 1 from public.organizations o where o.id = new.org_id and o.created_by = new.id
             and o.created_at > now() - interval '1 day')
     and not exists (select 1 from public.org_memberships m where m.org_id = new.org_id) then
    insert into public.org_memberships (org_id, user_id, role, granted_note)
    values (new.org_id, new.id, 'OWNER', 'Created by this user');
    return new;
  end if;
  raise exception 'You are not authorized for this organization' using errcode = '42501';
end $$;
revoke all on function public.guard_profile_active_org() from public, anon, authenticated;

drop trigger if exists profiles_guard_active_org on public.profiles;
create trigger profiles_guard_active_org
  before insert or update of org_id on public.profiles
  for each row execute function public.guard_profile_active_org();

-- The onboarding flow inserts an organization and reads it back
-- (insert ... returning) before the profile points at it. The existing
-- orgs_select_member policy only exposes the active organization, so allow a
-- creator to read an organization they created in the last day.
drop policy if exists orgs_select_recent_creator on public.organizations;
create policy orgs_select_recent_creator on public.organizations
  for select to authenticated
  using (created_by = (select auth.uid()) and created_at > now() - interval '1 day');

create or replace function public.my_organizations()
returns table (id uuid, name text, role text, active boolean)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, m.role, o.id = (select p.org_id from public.profiles p where p.id = auth.uid())
  from public.org_memberships m join public.organizations o on o.id = m.org_id
  where m.user_id = auth.uid()
  order by o.name
$$;
revoke all on function public.my_organizations() from public, anon;
grant execute on function public.my_organizations() to authenticated;

create or replace function public.set_active_org(p_org uuid) returns uuid
language plpgsql security invoker set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  update public.profiles set org_id = p_org where id = auth.uid();
  if not found then raise exception 'Profile not found' using errcode = 'P0002'; end if;
  return p_org;
end $$;
revoke all on function public.set_active_org(uuid) from public, anon;
grant execute on function public.set_active_org(uuid) to authenticated;
