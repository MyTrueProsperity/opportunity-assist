-- Daily email digest of new alert matches and upcoming pipeline deadlines.
--
-- profiles.email_digest: each person's opt-out (on by default). People change
-- it on the Organization page or with the one-click link in every email.
-- notification_log: what each organization has already been told, so a lead
-- or a deadline reminder is never emailed twice. Written only by the
-- scheduled function with the service role.
--
-- Additive only.
alter table public.profiles add column if not exists email_digest boolean not null default true;

create table if not exists public.notification_log (
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('alert_match', 'deadline')),
  item_key text not null,
  sent_at timestamptz not null default now(),
  primary key (org_id, kind, item_key)
);
alter table public.notification_log enable row level security;
revoke all on public.notification_log from public, anon, authenticated;
comment on table public.notification_log is
  'Alert matches and deadline reminders already emailed to an organization. Service role only.';
