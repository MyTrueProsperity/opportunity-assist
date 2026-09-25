-- Preserve the source volume's CB identifiers alongside the existing CFSC namespace.
alter table research_evidence.evidence_records drop constraint evidence_records_record_id_check;
alter table research_evidence.evidence_records add constraint evidence_records_record_id_check check (record_id ~ '^(CFSC|CB)-[0-9]{3}$');