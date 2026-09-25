-- An active research package must record when it was activated.
-- Staging and retired packages may keep a null activated_at; retiring or
-- returning a package to staging does not need to clear it.
-- Fails (rather than silently repairing data) if any active package lacks it.
do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'research_evidence.packages'::regclass
      and conname = 'packages_active_requires_activated_at'
  ) then
    alter table research_evidence.packages
      add constraint packages_active_requires_activated_at
      check (status <> 'active' or activated_at is not null);
  end if;
end $migration$;
