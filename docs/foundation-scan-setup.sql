-- Opportunity Assist — Foundation scan one-time setup
-- Run once in the Opportunity Assist Supabase project's SQL Editor.
-- Safe to re-run: every statement is idempotent.

-- Deliberately a separate table from `opportunities`, not a row type within
-- it. Rows in `opportunities` come from structured government APIs
-- (SAM.gov, Grants.gov) and are treated as authoritative. Rows here are an
-- AI's best read of a funder's webpage at scan time -- genuinely useful,
-- but a different kind of claim, and the app must label them accordingly
-- rather than mixing the two trust levels together.
create table if not exists foundation_scan_hits (
  id uuid primary key default gen_random_uuid(),
  funder_name text not null,
  source_url text not null,
  program_name text,
  summary text,
  deadline_mentioned text,
  amount_mentioned text,
  requires_loi boolean,
  application_url text,
  scanned_at timestamptz not null default now()
);

alter table foundation_scan_hits enable row level security;

-- Readable by everyone signed in, same visibility model as `opportunities`
-- itself -- this is shared reference data, not org-specific.
create policy "Anyone can view foundation scan hits"
  on foundation_scan_hits for select
  using (true);

-- Written only by foundation-scan-background.js using the service role key.
-- No client-facing insert/update/delete policy exists.
