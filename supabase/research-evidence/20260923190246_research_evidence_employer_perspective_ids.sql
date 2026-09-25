DO $migration$
DECLARE current_definition text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO current_definition
 FROM pg_constraint
 WHERE conrelid='research_evidence.evidence_records'::regclass
 AND conname='evidence_records_record_id_check';
 IF current_definition IS NULL THEN RAISE EXCEPTION 'Expected record identifier constraint'; END IF;
 IF current_definition NOT LIKE '%EP%' THEN
   EXECUTE 'ALTER TABLE research_evidence.evidence_records DROP CONSTRAINT evidence_records_record_id_check';
   EXECUTE 'ALTER TABLE research_evidence.evidence_records ADD CONSTRAINT evidence_records_record_id_check CHECK (' ||
     substring(current_definition from 7) || ' OR record_id ~ ''^EP-[0-9]{3}$'')';
 END IF;
END $migration$;