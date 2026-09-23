-- Preserve original CTE record IDs without replacing other installed volume namespaces.
-- No change to private-schema privileges, workspace bindings, or activation rules.
do $migration$
declare previous_expression text;
begin
  select pg_get_expr(conbin, conrelid) into strict previous_expression
  from pg_constraint
  where conrelid = 'research_evidence.evidence_records'::regclass
    and conname = 'evidence_records_record_id_check' and contype = 'c';
  if position('CTE_' in previous_expression) = 0 then
    alter table research_evidence.evidence_records drop constraint evidence_records_record_id_check;
    execute format(
      'alter table research_evidence.evidence_records add constraint evidence_records_record_id_check check ((%s) or record_id ~ %L)',
      previous_expression,
      '^CTE_(LOCAL|RESEARCH|EMPLOYER|FL|ACCESS|REGIONAL|FUTURE|POLICY)_[0-9]{3}$'
    );
  end if;
end $migration$;
