-- Fit scores carry their eligibility screen, rubric version and confidence,
-- and become stale automatically when anything they were calculated from changes.
--
-- A stale score (source_stale = true) is not shown as current; the app drops it
-- and requests a new score. A score from another rubric_version is treated the
-- same way by the app.

alter table public.fit_scores
  add column if not exists eligibility_status text,
  add column if not exists eligibility_reasons jsonb not null default '[]'::jsonb,
  add column if not exists rubric_version text,
  add column if not exists confidence numeric,
  add column if not exists scored_at timestamptz;
alter table public.fit_scores drop constraint if exists fit_scores_eligibility_status_check;
alter table public.fit_scores add constraint fit_scores_eligibility_status_check
  check (eligibility_status is null or eligibility_status in ('ELIGIBLE', 'INELIGIBLE', 'UNKNOWN'));

-- Organization profile fields used by scoring.
create or replace function public.fit_scores_stale_for_org() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.name, new.programs, new.service_areas, new.naics_codes, new.uei, new.sam_status,
      new.certifications, new.past_performance, new.target_populations, new.keywords)
     is distinct from
     (old.name, old.programs, old.service_areas, old.naics_codes, old.uei, old.sam_status,
      old.certifications, old.past_performance, old.target_populations, old.keywords) then
    update public.fit_scores set source_stale = true where org_id = new.id and not source_stale;
  end if;
  return new;
end $$;
revoke all on function public.fit_scores_stale_for_org() from public, anon, authenticated;
drop trigger if exists organizations_fit_scores_stale on public.organizations;
create trigger organizations_fit_scores_stale after update on public.organizations
  for each row execute function public.fit_scores_stale_for_org();

-- Opportunity fields used by screening and scoring.
create or replace function public.fit_scores_stale_for_opportunity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.title, new.summary, new.requirements, new.geography, new.deadline, new.category,
      new.funding_amount, new.funding_amount_label, new.source_active)
     is distinct from
     (old.title, old.summary, old.requirements, old.geography, old.deadline, old.category,
      old.funding_amount, old.funding_amount_label, old.source_active) then
    update public.fit_scores set source_stale = true where opportunity_id = new.id and not source_stale;
  end if;
  return new;
end $$;
revoke all on function public.fit_scores_stale_for_opportunity() from public, anon, authenticated;
drop trigger if exists opportunities_fit_scores_stale on public.opportunities;
create trigger opportunities_fit_scores_stale after update on public.opportunities
  for each row execute function public.fit_scores_stale_for_opportunity();
