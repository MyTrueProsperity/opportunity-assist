lock table research_evidence.evidence_records in access exclusive mode;
do $migration$
declare constraint_expr text;
begin
 select pg_get_expr(conbin,conrelid) into constraint_expr from pg_constraint
 where conrelid='research_evidence.evidence_records'::regclass and conname='evidence_records_record_id_check';
 if constraint_expr is null then raise exception 'Expected evidence ID constraint is missing'; end if;
 if position('^NC-' in constraint_expr)=0 then
  alter table research_evidence.evidence_records drop constraint evidence_records_record_id_check;
  execute format('alter table research_evidence.evidence_records add constraint evidence_records_record_id_check check ((%s) OR record_id ~ %L)',constraint_expr,'^NC-[0-9]{3}$');
 end if;
end $migration$;

