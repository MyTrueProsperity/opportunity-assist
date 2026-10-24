-- Grants.gov listings: remember when the full notice was read.
--
-- The daily crawler used to store only search results (title, agency, close
-- date), so most listings had no description or award amount and AI Fit
-- Scores were written from the title alone. It now reads each new listing's
-- full notice once (description, award floor/ceiling, eligible applicants,
-- forecast dates) and records when, so later runs neither repeat the call nor
-- overwrite the stored details with bare search results.
--
-- Additive only.
alter table public.opportunities add column if not exists detail_fetched_at timestamptz;
comment on column public.opportunities.detail_fetched_at is
  'When the crawler last read the full source notice (Grants.gov fetchOpportunity). Null means only search results are stored.';
