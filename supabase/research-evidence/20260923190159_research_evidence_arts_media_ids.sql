-- Extend only the existing research record-ID constraint for this volume.
-- Preserve all prefixes already accepted; change no access policy or data.
set local lock_timeout = '5s';
lock table research_evidence.evidence_records in share row exclusive mode;
do $arts_media$
declare prior_expression text;
begin
  select pg_get_expr(conbin,conrelid) into prior_expression
  from pg_constraint
  where conrelid='research_evidence.evidence_records'::regclass
    and conname='evidence_records_record_id_check';
  if prior_expression is null then
    raise exception 'Expected research record-ID constraint was not found';
  end if;
  if position('AM-' in prior_expression)=0 then
    alter table research_evidence.evidence_records drop constraint evidence_records_record_id_check;
    execute format('alter table research_evidence.evidence_records add constraint evidence_records_record_id_check check ((%s) or (record_id ~ ''^AM-[0-9]{3}$''))',prior_expression);
  end if;
end
$arts_media$;

