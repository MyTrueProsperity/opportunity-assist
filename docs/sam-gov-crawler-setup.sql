-- Opportunity Assist — SAM.gov crawler one-time setup
-- Run once in the Opportunity Assist Supabase project's SQL Editor.
-- Safe to re-run: every statement is idempotent.

-- Lets the crawler upsert (insert new, update existing) instead of creating
-- duplicate rows every time it re-crawls the same notice.
alter table opportunities add column if not exists external_id text;

create unique index if not exists opportunities_external_id_idx
  on opportunities (external_id)
  where external_id is not null;
