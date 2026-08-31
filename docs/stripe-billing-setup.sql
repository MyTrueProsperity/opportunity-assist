-- Opportunity Assist — Paywall / Stripe billing one-time setup
-- Run once in the Opportunity Assist Supabase project's SQL Editor.
-- Safe to re-run: every statement is idempotent.

create table if not exists subscriptions (
  org_id uuid primary key references organizations(id) on delete cascade,
  status text not null default 'inactive',   -- inactive | active | past_due | canceled
  plan text,                                  -- professional | team | enterprise
  stripe_customer_id text,
  stripe_subscription_id text,
  updated_at timestamptz not null default now()
);

alter table subscriptions enable row level security;

-- Org members can READ their own org's status (the Organization page shows
-- it), but there is no INSERT/UPDATE/DELETE policy for anyone. Only the
-- service_role key (used exclusively by netlify/functions/stripe-webhook.js)
-- can write this table. That's what makes the paywall trustworthy: a signed-
-- in user can't flip their own status to "active" the way they can edit
-- other fields on their own organization.
create policy "Org members can view their subscription"
  on subscriptions for select
  using (org_id in (select org_id from profiles where id = auth.uid()));

-- To comp an organization without going through Stripe (e.g. MTP's own
-- account), run this once with the real org id:
--
-- insert into subscriptions (org_id, status, plan)
-- values ('00000000-0000-0000-0000-000000000000', 'active', 'enterprise')
-- on conflict (org_id) do update set status = 'active', plan = 'enterprise';
