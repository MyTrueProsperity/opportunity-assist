-- Alerts: store the fit-score threshold.
--
-- The live alert_rules table (name, keywords text[], geography, min_amount,
-- category, active) was created by the original schema. The app wrote type,
-- keyword and min_score columns that never existed there, so every save
-- failed and no alert rule was ever stored. The app now writes the live
-- columns; the only missing piece is a place for the fit-score threshold.
--
-- Additive only. Existing columns, policies and rows are unchanged.

alter table public.alert_rules add column if not exists min_score integer;

alter table public.alert_rules drop constraint if exists alert_rules_min_score_range;
alter table public.alert_rules add constraint alert_rules_min_score_range
  check (min_score is null or min_score between 0 and 100);

-- A rule has to watch for something, or it would match nothing (or everything).
alter table public.alert_rules drop constraint if exists alert_rules_watches_something;
alter table public.alert_rules add constraint alert_rules_watches_something
  check (coalesce(cardinality(keywords), 0) > 0 or min_score is not null or min_amount is not null
         or nullif(btrim(category), '') is not null or nullif(btrim(geography), '') is not null);
