alter table research_evidence.evidence_records drop constraint evidence_records_record_id_check;
alter table research_evidence.evidence_records add constraint evidence_records_record_id_check check (
  (record_id ~ '^(CFSC|CB)-[0-9]{3}$') OR (record_id ~ '^AM-[0-9]{3}$') OR (record_id ~ '^EP-[0-9]{3}$') OR
  (record_id ~ '^EM-[0-9]{3}$') OR (record_id ~ '^NC-[0-9]{3}$') OR
  (record_id ~ '^CTE_(LOCAL|RESEARCH|EMPLOYER|FL|ACCESS|REGIONAL|FUTURE|POLICY)_[0-9]{3}$') OR
  (record_id ~ '^GW-[0-9]{3}$') OR (record_id ~ '^CNE-[0-9]{3}$'));