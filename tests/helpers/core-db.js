"use strict";
// Minimal replica of the production Opportunity Assist core schema that the
// organization-switching and fit-score migrations depend on: organizations,
// profiles, opportunities, fit_scores, subscriptions, current_org_id() and the
// production row-level-security policies for those tables (copied from
// pg_policies on 2026-09-25). Then applies supabase/opportunity-assist/*.sql.
const { PGlite } = require("@electric-sql/pglite");
const fs = require("node:fs");
const path = require("node:path");

const BILL = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const NEW_USER = "33333333-3333-4333-8333-333333333333";
const MTP = "44444444-4444-4444-8444-444444444444";
const INSTITUTE = "55555555-5555-4555-8555-555555555555";
const STRANGER_ORG = "66666666-6666-4666-8666-666666666666";

async function coreDb({ migrate = true } = {}) {
  const pg = new PGlite();
  await pg.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
create table public.organizations(id uuid primary key default gen_random_uuid(), name text not null, programs text, service_areas text, naics_codes text[], uei text, sam_status text, certifications text, past_performance text, target_populations text, keywords text[], created_by uuid, created_at timestamptz not null default now());
create table public.profiles(id uuid primary key, email text, full_name text, org_id uuid references public.organizations(id), created_at timestamptz not null default now());
create table public.opportunities(id uuid primary key default gen_random_uuid(), source text, external_id text, title text, summary text, ai_summary jsonb, funding_amount numeric, funding_amount_label text, deadline date, requirements text, geography text, category text, source_url text, source_active boolean, created_at timestamptz default now());
create table public.fit_scores(id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade, opportunity_id uuid not null references public.opportunities(id) on delete cascade, headline_score integer, recommendation text, factors jsonb, created_at timestamptz not null default now(), source_stale boolean not null default false, unique(org_id, opportunity_id));
create table public.subscriptions(org_id uuid primary key references public.organizations(id), status text);
create function public.current_org_id() returns uuid language sql stable security definer set search_path to 'public' as $$ select org_id from public.profiles where id = auth.uid() $$;
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.opportunities enable row level security;
alter table public.fit_scores enable row level security;
alter table public.subscriptions enable row level security;
create policy orgs_insert_authed on public.organizations for insert with check ((select auth.uid()) is not null);
create policy orgs_select_member on public.organizations for select using (id = (select current_org_id()));
create policy orgs_update_member on public.organizations for update using (id = (select current_org_id()));
create policy profiles_insert_own on public.profiles for insert with check (id = (select auth.uid()));
create policy profiles_select_own on public.profiles for select using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update using (id = (select auth.uid()));
create policy opps_select_authed on public.opportunities for select using ((select auth.uid()) is not null);
create policy fit_all_org on public.fit_scores for all using (org_id = (select current_org_id())) with check (org_id = (select current_org_id()));
create policy subs_select on public.subscriptions for select using (org_id in (select profiles.org_id from profiles where profiles.id = auth.uid()));
grant all on all tables in schema public to anon, authenticated, service_role;
insert into public.organizations(id, name, service_areas, created_by, created_at) values
  ('${MTP}', 'My True Prosperity, LLC', 'Florida', '${BILL}', '2026-09-16'),
  ('${INSTITUTE}', 'Institute of Bright Minds', 'Seminole County, Florida', '${BILL}', '2026-09-16'),
  ('${STRANGER_ORG}', 'Unrelated Nonprofit', 'Ohio', '${OTHER_USER}', '2026-09-16');
insert into public.profiles(id, email, org_id) values ('${BILL}', 'bill@example.org', '${MTP}'), ('${OTHER_USER}', 'other@example.org', '${STRANGER_ORG}'), ('${NEW_USER}', 'new@example.org', null);
insert into public.subscriptions values ('${MTP}', 'active'), ('${INSTITUTE}', 'active'), ('${STRANGER_ORG}', 'active');
`);
  if (migrate) {
    const dir = path.join(__dirname, "../../supabase/opportunity-assist");
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) await pg.exec(fs.readFileSync(path.join(dir, f), "utf8"));
  }
  // Run a callback as a signed-in user (authenticated role + JWT subject).
  async function as(user, fn) {
    await pg.exec("begin");
    try {
      await pg.exec("set local role authenticated");
      await pg.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
      const out = await fn({ q: async (sql, args) => (await pg.query(sql, args)).rows });
      await pg.exec("commit");
      return out;
    } catch (e) {
      await pg.exec("rollback");
      throw e;
    }
  }
  return { pg, as };
}
module.exports = { coreDb, BILL, OTHER_USER, NEW_USER, MTP, INSTITUTE, STRANGER_ORG };
