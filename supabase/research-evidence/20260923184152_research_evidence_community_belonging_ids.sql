-- Preserve Community and Belonging's original IDs while retaining the existing CFSC namespace.
-- Research remains private, package-versioned, and workspace-bound.
alter table research_evidence.evidence_records
  drop constraint evidence_records_record_id_check;
alter table research_evidence.evidence_records
  add constraint evidence_records_record_id_check
  check (record_id ~ '^(CFSC|CB)-[0-9]{3}$');
