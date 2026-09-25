'use strict';
// An active research package must record activated_at; staging and retired
// packages may not have one. Normal load, activation and rollback still work.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createTestRepo, ORG, OWNER } = require('./helpers/grant-db');
const DIR = path.join(__dirname, '../supabase/research-evidence');

async function fixture() {
  const f = await createTestRepo();
  for (const name of fs.readdirSync(DIR).filter(n => n.endsWith('.sql')).sort())
    await f.pg.exec(fs.readFileSync(path.join(DIR, name), 'utf8'));
  f.row = async v => (await f.pg.query('select status, activated_at from research_evidence.packages where package_version=$1', [v])).rows[0];
  return f;
}

test('active packages require activated_at; staging and retired packages do not', async () => {
  const f = await fixture();
  try {
    await f.pg.exec("insert into research_evidence.packages(package_version,metadata) values('P','{}')");
    assert.deepEqual(await f.row('P'), { status: 'staging', activated_at: null }, 'loads as staging without a timestamp');
    await assert.rejects(f.pg.exec("update research_evidence.packages set status='active' where package_version='P'"), /packages_active_requires_activated_at/);
    await assert.rejects(f.pg.exec("insert into research_evidence.packages(package_version,metadata,status) values('Q','{}','active')"), /packages_active_requires_activated_at/);
    await f.pg.query('insert into research_evidence.package_workspaces values($1,$2)', ['P', ORG]);
    await f.pg.exec("update research_evidence.packages set status='active',activated_at=now() where package_version='P'");
    assert.equal((await f.row('P')).status, 'active');
    await assert.rejects(f.pg.exec("update research_evidence.packages set activated_at=null where package_version='P'"), /packages_active_requires_activated_at/);
    // Rollback paths keep working and keep the historical activation time.
    await f.pg.exec("update research_evidence.packages set status='retired' where package_version='P'");
    assert.ok((await f.row('P')).activated_at);
    await f.pg.exec("update research_evidence.packages set status='staging', activated_at=null where package_version='P'");
    assert.deepEqual(await f.row('P'), { status: 'staging', activated_at: null });
    const bundle = (await f.pg.query('select gf_research_bundle($1,$2) b', [ORG, OWNER])).rows[0].b;
    assert.equal(bundle.packages.length, 0, 'staging package stays hidden');
  } finally { await f.pg.close(); }
});

test('activation migration is idempotent', async () => {
  const f = await fixture();
  try {
    await f.pg.exec(fs.readFileSync(path.join(DIR, '20260925152433_research_evidence_active_requires_activated_at.sql'), 'utf8'));
    const n = (await f.pg.query("select count(*)::int n from pg_constraint where conname='packages_active_requires_activated_at'")).rows[0].n;
    assert.equal(n, 1);
  } finally { await f.pg.close(); }
});
