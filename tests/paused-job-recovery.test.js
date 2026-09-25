'use strict';
// Paused-job recovery: budget pauses stay on the budget requeue path; other
// pauses resume after a one-hour backoff without spending retry attempts.
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
let pg;
const actor = '11111111-1111-4111-8111-111111111111';
const baseSchema = `create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated,service_role;grant execute on function auth.uid() to authenticated,service_role;
create table admins(profile_id uuid primary key);insert into admins values('${actor}');
create table opportunities(id uuid primary key default gen_random_uuid(),external_id text unique,source text,title text,source_url text,category text,geography text,summary text,requirements text,deadline date,funding_amount numeric,funding_amount_label text,deadline_mentioned text,amount_mentioned text,deadline_verified boolean,amount_verified boolean,ai_summary jsonb,created_at timestamptz default now());
create table fit_scores(id uuid primary key default gen_random_uuid(),opportunity_id uuid references opportunities,org_id uuid,headline_score integer);
create table foundation_scan_hits(id uuid primary key default gen_random_uuid(),funder_name text,source_url text);`;
test.before(async () => { pg = new PGlite(); await pg.exec(baseSchema); const dir = path.join(__dirname, '../supabase/migrations'); for (const f of fs.readdirSync(dir).sort()) await pg.exec(fs.readFileSync(path.join(dir, f), 'utf8')); });
test.after(async () => await pg.close());
test.beforeEach(async () => { await pg.exec('begin;'); await pg.exec("update source_engine_settings set engine_enabled=true;update source_state_settings set monitoring_enabled=true where state_code='FL'"); });
test.afterEach(async () => await pg.exec('rollback;'));
const scalar = async (sql, args = []) => Object.values((await pg.query(sql, args)).rows[0] || {})[0];
const claim = async () => (await pg.query('select * from source_claim_job()')).rows[0];
const BUDGET = 'Daily state or global budget reached; resume after the UTC reset';
const DISABLED = 'Coverage category is disabled';
async function job(key) {
  const run = await scalar("insert into source_discovery_runs(strategy,state_code) values('MONITOR','FL') returning id");
  return scalar("insert into source_jobs(dedupe_key,run_id,kind,state_code) values($1,$2,'MONITOR','FL') returning id", [key, run]);
}
const finish = (j, status, error) => pg.query('select source_finish_job($1,$2,$3,$4)', [j.id, j.lease_token, status, error]);
const due = (id) => pg.query("update source_jobs set available_at=now()-interval '1 second' where id=$1", [id]);
const row = async (id) => (await pg.query('select status,attempts,available_at>now() as later,available_at>now()+interval \'50 minutes\' as backoff from source_jobs where id=$1', [id])).rows[0];

test('a budget pause is never reclaimed directly and keeps the budget requeue path', async () => {
  const id = await job('budget');
  const j = await claim(); assert.equal(j.id, id);
  await finish(j, 'PAUSED', BUDGET);
  assert.deepEqual(await row(id), { status: 'PAUSED', attempts: 1, later: false, backoff: false });
  for (let i = 0; i < 5; i++) assert.equal(await claim(), undefined, 'no tight reclaim loop on budget pauses');
  assert.equal((await row(id)).attempts, 1, 'no attempts burned');
  // The existing budget requeue still resumes it once the day or budget changes.
  await pg.query("update source_jobs set available_at=now()-interval '2 days', created_at=now()-interval '2 days' where id=$1", [id]);
  assert.equal(await scalar('select source_requeue_budget_jobs()'), 1);
  assert.equal((await row(id)).status, 'QUEUED');
});

test('a non-budget pause gives the attempt back and waits an hour before it can be reclaimed', async () => {
  const id = await job('disabled');
  const j = await claim();
  await finish(j, 'PAUSED', DISABLED);
  assert.deepEqual(await row(id), { status: 'PAUSED', attempts: 0, later: true, backoff: true });
  assert.equal(await claim(), undefined, 'not reclaimed before the backoff expires');
  await due(id);
  const again = await claim();
  assert.equal(again.id, id);
  assert.equal(again.attempts, 1);
});

test('repeated non-budget pauses are bounded to one check per backoff and never exhaust retries', async () => {
  const id = await job('persisting');
  for (let cycle = 0; cycle < 10; cycle++) {
    const j = await claim();
    assert.equal(j.id, id, 'claimed once per cycle after the backoff');
    await finish(j, 'PAUSED', DISABLED);
    assert.equal(await claim(), undefined, 'at most one claim per backoff window');
    await due(id);
  }
  assert.equal((await row(id)).attempts, 0);
});

test('real failures still exhaust retries; a paused job at the attempt limit is not claimed', async () => {
  const id = await job('failing');
  for (let i = 0; i < 3; i++) { const j = await claim(); assert.equal(j.id, id); await finish(j, 'QUEUED', 'Temporary fetch error'); await due(id); }
  assert.equal(await claim(), undefined, 'three real attempts used');
  await pg.query("update source_jobs set status='PAUSED', last_error=$2, available_at=now()-interval '1 second' where id=$1", [id, DISABLED]);
  assert.equal(await claim(), undefined, 'attempts < 3 still gates paused reclaim');
});

test('duplicate execution protection is unchanged: a running job is not claimed twice and an old lease cannot finish', async () => {
  const id = await job('lease');
  const first = await claim();
  assert.equal(await claim(), undefined, 'a job with a live lease is not claimed again');
  await finish(first, 'PAUSED', DISABLED);
  await due(id);
  const second = await claim();
  assert.notEqual(second.lease_token, first.lease_token);
  await pg.exec('savepoint stale_lease');
  await assert.rejects(finish(first, 'COMPLETED', null), /Job lease lost/);
  await pg.exec('rollback to savepoint stale_lease');
  await finish(second, 'COMPLETED', null);
  assert.equal((await row(id)).status, 'COMPLETED');
});

test('recovery after the pause condition clears: disabled state blocks the reclaim, re-enabling resumes it', async () => {
  const id = await job('state-off');
  const j = await claim();
  await pg.exec("update source_state_settings set monitoring_enabled=false,discovery_enabled=false where state_code='FL'");
  await finish(j, 'PAUSED', 'This state is disabled for source verification');
  await due(id);
  assert.equal(await claim(), undefined, 'still disabled, so not claimed even when due');
  await pg.exec("update source_state_settings set monitoring_enabled=true where state_code='FL'");
  assert.equal((await claim()).id, id);
});
