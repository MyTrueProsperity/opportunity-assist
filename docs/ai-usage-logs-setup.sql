-- Opportunity Assist — AI Fit Scoring one-time setup
-- Run once in the Opportunity Assist Supabase project's SQL Editor.
-- Safe to re-run: every statement is idempotent.

-- Global cache for the AI-generated Q&A summary shown on the opportunity detail
-- page. Written only by score-opportunities.js using the service_role key.
alter table opportunities add column if not exists ai_summary jsonb;

-- Usage log for the AI Fit Scoring function, one row per scoring batch.
-- Written only by score-opportunities.js using the service_role key.
create table if not exists ai_usage_logs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  model text not null,
  opportunity_count integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_logs_org_id_idx on ai_usage_logs (org_id, created_at desc);

-- RLS is enabled with no policies attached on purpose: with zero policies,
-- only the service_role key (which bypasses RLS entirely) can read or write
-- this table. Authenticated users get nothing, by default, from the client.
alter table ai_usage_logs enable row level security;
