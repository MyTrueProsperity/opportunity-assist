-- Private planning framework for each Grant Factory workspace.
-- Holds institution-specific program funding alignment, a logic model
-- framework and a quarantine list of unverified claims. It is planning and
-- review material, never evidence: it is not a fact, is never passed to the
-- writer as support, and quarantined claims are never draft-eligible.
-- Additive and nullable; no existing row or column is changed.
alter table public.gf_workspaces add column if not exists framework jsonb;
comment on column public.gf_workspaces.framework is
  'Planning framework (program alignment, logic model, quarantined claims). Not evidence. Maintained by trusted administration.';
