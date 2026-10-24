-- Opportunity Assist — Admin backdoor, Contract Watch, Alert Rules setup
-- Run once in the Opportunity Assist Supabase project's SQL Editor.
-- Safe to re-run: every statement is idempotent.

-- ============================================================
-- ADMIN ACCESS
-- ============================================================
-- A separate table rather than a column on profiles, on purpose: profiles
-- already has a client-writable update policy (used by onboarding), and
-- admin status must never be settable by the client under any circumstance.
create table if not exists admins (
  profile_id uuid primary key references profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table admins enable row level security;

-- Users can check their OWN admin status (so the app can decide whether to
-- show the Admin nav item). No INSERT/UPDATE/DELETE policy exists for
-- anyone -- only the service_role, i.e. only you, running SQL directly, can
-- grant it.
create policy "Users can view their own admin status"
  on admins for select
  using (profile_id = auth.uid());

-- Admins can view every organization and subscription, not just their own.
-- These ADD to whatever SELECT policies already exist -- Postgres RLS
-- policies are OR'd together, so this only ever expands visibility for
-- admin-flagged users and changes nothing for anyone else.
create policy "Admins can view all organizations"
  on organizations for select
  using (auth.uid() in (select profile_id from admins));

create policy "Admins can view all subscriptions"
  on subscriptions for select
  using (auth.uid() in (select profile_id from admins));

-- To make yourself (or anyone) an admin, find your user id from Supabase
-- Auth -> Users (or `select id, email from auth.users where email = '...'`),
-- then run:
--
-- insert into admins (profile_id) values ('00000000-0000-0000-0000-000000000000');

-- ============================================================
-- CONTRACT WATCH
-- ============================================================
-- Matches the live table, which the original schema created first (this
-- "if not exists" never replaced it). Columns are what app.html writes.
create table if not exists contracts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  renewal_date date,
  expected_rebid date,
  incumbent text,
  status text,
  notes text,
  created_at timestamptz not null default now()
);
alter table contracts enable row level security;

create policy "Org members can view their contracts"
  on contracts for select
  using (org_id in (select org_id from profiles where id = auth.uid()));
create policy "Org members can insert their contracts"
  on contracts for insert
  with check (org_id in (select org_id from profiles where id = auth.uid()));
create policy "Org members can update their contracts"
  on contracts for update
  using (org_id in (select org_id from profiles where id = auth.uid()));
create policy "Org members can delete their contracts"
  on contracts for delete
  using (org_id in (select org_id from profiles where id = auth.uid()));

-- ============================================================
-- ALERT RULES
-- ============================================================
-- Matches the live table. An earlier version of this file described type /
-- keyword / min_score columns that never existed in production, which is why
-- alert rules could not be saved. min_score comes from
-- supabase/opportunity-assist/20261023210313_alert_rules_fit_threshold.sql.
create table if not exists alert_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  keywords text[],
  geography text,
  min_amount numeric,
  category text,
  active boolean default true,
  min_score integer check (min_score is null or min_score between 0 and 100),
  created_at timestamptz not null default now()
);
alter table alert_rules enable row level security;

create policy "Org members can view their alert rules"
  on alert_rules for select
  using (org_id in (select org_id from profiles where id = auth.uid()));
create policy "Org members can insert their alert rules"
  on alert_rules for insert
  with check (org_id in (select org_id from profiles where id = auth.uid()));
create policy "Org members can delete their alert rules"
  on alert_rules for delete
  using (org_id in (select org_id from profiles where id = auth.uid()));
