'use strict';
// The repository migration chain, the package validator and the production
// record-ID constraint must accept exactly the same research namespaces.
// A new research-volume prefix needs both a narrow migration and a validator update.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { RECORD_ID } = require('../scripts/prepare-research-package.cjs');
const { createTestRepo } = require('./helpers/grant-db');

const DIR = path.join(__dirname, '../supabase/research-evidence');
// One representative ID per live namespace (production constraint as of 2026-09-25).
const LIVE = ['CFSC-001', 'CB-001', 'AM-001', 'EP-001', 'EM-001', 'NC-001', 'GW-001', 'CNE-001', 'YW-001',
  ...['LOCAL', 'RESEARCH', 'EMPLOYER', 'FL', 'ACCESS', 'REGIONAL', 'FUTURE', 'POLICY'].map(k => `CTE_${k}_001`)];
const INVALID = ['CFSC-1', 'GW-0001', 'E-01', 'GWX-001', 'XX-001', 'CTE_UNKNOWN_001', 'CTE_LOCAL_001_extra', 'cne-001', ' YW-001'];
// Production pg_get_constraintdef after 20260925133347_research_evidence_youth_workforce_ids.
const PRODUCTION = "CHECK (((record_id ~ '^(CFSC|CB)-[0-9]{3}$'::text) OR (record_id ~ '^AM-[0-9]{3}$'::text) OR (record_id ~ '^EP-[0-9]{3}$'::text) OR (record_id ~ '^EM-[0-9]{3}$'::text) OR (record_id ~ '^NC-[0-9]{3}$'::text) OR (record_id ~ '^CTE_(LOCAL|RESEARCH|EMPLOYER|FL|ACCESS|REGIONAL|FUTURE|POLICY)_[0-9]{3}$'::text) OR (record_id ~ '^GW-[0-9]{3}$'::text) OR (record_id ~ '^CNE-[0-9]{3}$'::text) OR (record_id ~ '^YW-[0-9]{3}$'::text)))";

async function chain() {
  const f = await createTestRepo();
  for (const name of fs.readdirSync(DIR).filter(n => n.endsWith('.sql')).sort())
    await f.pg.exec(fs.readFileSync(path.join(DIR, name), 'utf8'));
  await f.pg.exec("insert into research_evidence.packages(package_version,metadata) values('NS','{}')");
  f.accepts = async id => {
    await f.pg.exec('savepoint s');
    try {
      await f.pg.query("insert into research_evidence.evidence_records(package_version,record_id,topic,evidence_level,geography_scope,funding_tags,qa_flags,source_url,verification_status,last_verified,review_before_external_use,payload) values('NS',$1,'t','A','{NATIONAL}','{}','{}','https://example.org','PRIMARY_VERIFIED','2026-09-25',false,'{}')", [id]);
      await f.pg.exec('rollback to savepoint s'); return true;
    } catch { await f.pg.exec('rollback to savepoint s'); return false; }
  };
  await f.pg.exec('begin');
  return f;
}

test('repository migration chain reproduces the production record-ID constraint', async () => {
  const f = await chain();
  try {
    const def = (await f.pg.query("select pg_get_constraintdef(oid) d from pg_constraint where conname='evidence_records_record_id_check'")).rows[0].d;
    assert.equal(def, PRODUCTION);
  } finally { await f.pg.close(); }
});

test('validator and migration chain accept every live namespace and reject the same invalid IDs', async () => {
  const f = await chain();
  try {
    for (const id of LIVE) {
      assert.ok(RECORD_ID.test(id), 'validator accepts ' + id);
      assert.ok(await f.accepts(id), 'migrations accept ' + id);
    }
    for (const id of INVALID) {
      assert.equal(RECORD_ID.test(id), false, 'validator rejects ' + id);
      assert.equal(await f.accepts(id), false, 'migrations reject ' + id);
    }
  } finally { await f.pg.close(); }
});

test('every namespace migration file matches a recorded production version', () => {
  // Filenames follow Supabase history: <version>_<name>.sql, with versions unique and ordered.
  const files = fs.readdirSync(DIR).filter(n => n.endsWith('.sql')).sort();
  const versions = files.map(n => n.match(/^(\d{14})_[a-z0-9_]+\.sql$/)?.[1]);
  assert.ok(versions.every(Boolean), 'all research migrations are versioned');
  assert.equal(new Set(versions).size, versions.length);
  for (const v of ['20260923184152', '20260923190159', '20260923190246', '20260923192707', '20260923193828', '20260923210805', '20260925132115', '20260925132215', '20260925133347'])
    assert.ok(versions.includes(v), 'namespace migration present: ' + v);
});
