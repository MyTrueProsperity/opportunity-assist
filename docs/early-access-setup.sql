-- Opportunity Assist — Early access capture one-time setup
-- Run once in the Opportunity Assist Supabase project's SQL Editor.
-- Safe to re-run: every statement is idempotent.

create table if not exists early_access_requests (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text not null,
  organization text,
  message text,
  created_at timestamptz not null default now()
);

alter table early_access_requests enable row level security;

-- No policies attached on purpose: this table is written only by
-- netlify/functions/request-early-access.js using the service role key.
-- The public landing page never talks to Supabase directly. Check new
-- submissions in Supabase's Table Editor, or query:
--   select * from early_access_requests order by created_at desc;
