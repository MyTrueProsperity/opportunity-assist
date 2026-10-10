'use strict';
// Pass & Share with FinCap: database-level tests on PGlite (no production access).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const ADMIN = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const MEMBER2 = '33333333-3333-4333-8333-333333333333';
const OUTSIDER = '44444444-4444-4444-8444-444444444444';
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_NAME = 'Sunrise Youth Collective';
const SECRET_NOTE = 'PRIVATE-NOTE-do-not-publish';
const SECRET_REASON = 'PRIVATE-REASON-board-said-no';
const SECRET_AI = 'ORG-SPECIFIC-AI-SUMMARY Sunrise Youth Collective is a strong fit';

let pg;
const baseSchema = `
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, service_role, anon;
grant execute on function auth.uid() to authenticated, service_role, anon;
grant usage on schema public to authenticated, service_role, anon;
create table profiles(id uuid primary key);
create table admins(profile_id uuid primary key references profiles(id), created_at timestamptz not null default now());
create table organizations(id uuid primary key, name text not null);
create table org_memberships(org_id uuid references organizations on delete cascade, user_id uuid references profiles, role text default 'MEMBER', primary key(org_id, user_id));
create table funding_organizations(id uuid primary key default gen_random_uuid(), canonical_name text);
create table funding_programs(id uuid primary key default gen_random_uuid(), organization_id uuid references funding_organizations, funding_categories text[], applicant_types text[]);
create table funding_cycles(id uuid primary key default gen_random_uuid(), cycle_key text not null);
create table opportunities(id uuid primary key default gen_random_uuid(), source text, title text, summary text, ai_summary jsonb,
  funding_amount numeric, funding_amount_label text, deadline date, requirements text, geography text, category text, source_url text,
  deadline_verified boolean, amount_verified boolean, funding_program_id uuid, source_cycle_id uuid, source_active boolean default true, source_verified_at timestamptz);
create table pipeline_items(id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations on delete cascade, opportunity_id uuid references opportunities on delete set null, title text, stage text, notes text);
create table pursue_decisions(id uuid primary key default gen_random_uuid(), org_id uuid not null, opportunity_id uuid references opportunities on delete set null,
  pipeline_item_id uuid references pipeline_items on delete set null, system_recommendation text, system_confidence integer,
  decision text not null check (decision in ('pursue','watch','pass')), reason text, decided_by uuid references profiles, decided_at timestamptz not null default now());
create table opportunity_activity(id uuid primary key default gen_random_uuid(), org_id uuid not null, opportunity_id uuid references opportunities on delete set null,
  pipeline_item_id uuid references pipeline_items on delete cascade, actor_id uuid, action text not null, detail text, created_at timestamptz default now());
insert into profiles values ('${ADMIN}'),('${MEMBER}'),('${MEMBER2}'),('${OUTSIDER}');
insert into admins(profile_id) values ('${ADMIN}');
insert into organizations values ('${ORG}', '${ORG_NAME}'), ('${ORG2}', 'Harbor Light Alliance');
insert into org_memberships(org_id, user_id) values ('${ORG}','${MEMBER}'), ('${ORG2}','${MEMBER2}');
`;

async function migrate() {
  const f = path.join(__dirname, '../supabase/fincap-sharing/20261001000001_fincap_sharing.sql');
  await pg.exec(fs.readFileSync(f, 'utf8'));
}
test.before(async () => { pg = new PGlite(); await pg.exec(baseSchema); await migrate(); await migrate();
  await pg.exec('create function test_sub(o uuid) returns table(id uuid, version integer) language sql security definer as $$ select s.id, s.version from fincap_submissions s where s.opportunity_id = o $$; grant execute on function test_sub(uuid) to authenticated, service_role;'); });
test.after(async () => { await pg.close(); });
test.beforeEach(async () => { await pg.exec('begin;'); });
test.afterEach(async () => { await pg.exec('rollback;'); });

async function rej(fn, re) { await pg.exec('savepoint r'); await assert.rejects(fn(), re); await pg.exec('rollback to savepoint r'); }
const sup = () => pg.exec('reset role; select set_config(\'request.jwt.claim.sub\', \'\', true);');
const as = (uid) => pg.exec(`reset role; set local role authenticated; select set_config('request.jwt.claim.sub','${uid}',true);`);
const service = () => pg.exec("reset role; set local role service_role; select set_config('request.jwt.claim.sub','',true);");
const scalar = async (sql, args = []) => Object.values((await pg.query(sql, args)).rows[0] || {})[0];

async function opp(over = {}) {
  const o = {
    title: 'Community Money Grant', source: 'Example Foundation', source_url: 'https://example.org/grants/money',
    geography: 'Florida', deadline: '2026-12-15', deadline_verified: true, funding_amount_label: 'Up to $50,000', amount_verified: true,
    category: 'Financial capability', summary: 'funder prose ' + SECRET_AI, ai_summary: JSON.stringify({ what: SECRET_AI }),
    source_verified_at: '2026-09-30T12:00:00Z', ...over };
  return scalar(`insert into opportunities(title,source,source_url,geography,deadline,deadline_verified,funding_amount_label,amount_verified,category,summary,ai_summary,source_verified_at,source_cycle_id,funding_program_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [o.title, o.source, o.source_url, o.geography, o.deadline, o.deadline_verified, o.funding_amount_label, o.amount_verified, o.category, o.summary, o.ai_summary, o.source_verified_at, o.source_cycle_id || null, o.funding_program_id || null]);
}
const passShare = (org, oppId, item = null) => pg.query('select fincap_pass_and_share($1,$2,$3,$4,$5) r', [org, oppId, 'Pass', 31, item]).then((r) => r.rows[0].r);
const GOOD = { summary: 'A statewide grant for nonprofits that teach practical money skills to young adults. Funds classroom materials and coach stipends.', eligible_applicants: 'Nonprofits and schools', geography: 'Florida only' };
const edit = async (id, fields, v) => pg.query('select fincap_admin_edit($1,$2,$3) r', [id, JSON.stringify(fields), v]).then((r) => r.rows[0].r);
const decide = async (id, action, reason, v) => {
 const result=(await pg.query('select fincap_admin_decide($1,$2,$3,$4) r',[id,action,reason,v])).rows[0].r;
 if(action==='approve'){await sup();await pg.query("update fincap_submissions set published_at='2026-10-10T10:00:00Z' where id=$1",[id]);await as(ADMIN);}
 return result;
};
async function submissionFor(oppId) { return (await pg.query('select id, version from test_sub($1)', [oppId])).rows[0]; }
async function publish(oppId, fields = GOOD) {
  await as(MEMBER); await passShare(ORG, oppId); await as(ADMIN);
  let s = await submissionFor(oppId); const e = await edit(s.id, fields, s.version);
  const d = await decide(s.id, 'approve', null, e.version); await sup(); return { id: s.id, ...d };
}

test('migration is idempotent and every new table has RLS and no client grants', async () => {
  const t = await pg.query("select relname, relrowsecurity from pg_class where relname like 'fincap_%' and relkind='r'");
  assert.equal(t.rows.length, 5);
  assert.ok(t.rows.every((r) => r.relrowsecurity));
  await as(MEMBER);
  await rej(() => pg.query('select * from fincap_submissions'), /permission denied/);
  await rej(() => pg.query('select * from fincap_submission_shares'), /permission denied/);
});

test('Pass & Share records the private pass, one submission, attribution and activity', async () => {
  const o = await opp(); await as(MEMBER);
  const r = await passShare(ORG, o);
  assert.equal(r.submission_status, 'pending_review'); assert.equal(r.created, true);
  await sup();
  assert.equal(await scalar("select count(*)::int from pursue_decisions where org_id=$1 and opportunity_id=$2 and decision='pass' and system_confidence=31", [ORG, o]), 1);
  assert.equal(await scalar('select count(*)::int from fincap_submissions'), 1);
  assert.equal(await scalar('select count(*)::int from fincap_submission_shares where org_id=$1', [ORG]), 1);
  assert.equal(await scalar("select count(*)::int from opportunity_activity where action='pursue_decision'"), 1);
  assert.equal(await scalar('select status from fincap_submissions'), 'pending_review');
  assert.equal(await scalar('select pub_summary is null from fincap_submissions'), true, 'summary is never prefilled from ai_summary or summary');
  assert.equal(await scalar('select count(*)::int from opportunities where id=$1', [o]), 1, 'original opportunity preserved');
});

test('double clicks and retries create no duplicates', async () => {
  const o = await opp(); await as(MEMBER);
  const a = await passShare(ORG, o); const b = await passShare(ORG, o); const c = await passShare(ORG, o);
  assert.equal(a.decision_id, b.decision_id); assert.equal(b.decision_id, c.decision_id);
  assert.equal(b.already_submitted, true);
  await sup();
  assert.equal(await scalar('select count(*)::int from pursue_decisions'), 1);
  assert.equal(await scalar('select count(*)::int from fincap_submissions'), 1);
  assert.equal(await scalar('select count(*)::int from opportunity_activity'), 1);
  await rej(() => pg.query("insert into fincap_submissions(identity_key,cycle_key) select identity_key,cycle_key from fincap_submissions"), /unique/);
});

test('a pipeline card is removed atomically and its history re-homed', async () => {
  const o = await opp();
  const item = await scalar("insert into pipeline_items(org_id,opportunity_id,title,stage,notes) values($1,$2,'t','Reviewing',$3) returning id", [ORG, o, SECRET_NOTE]);
  await pg.query("insert into opportunity_activity(org_id,opportunity_id,pipeline_item_id,action) values($1,$2,$3,'stage_changed')", [ORG, o, item]);
  await as(MEMBER); await passShare(ORG, o, item); await sup();
  assert.equal(await scalar('select count(*)::int from pipeline_items'), 0);
  assert.equal(await scalar("select count(*)::int from opportunity_activity where action='stage_changed' and pipeline_item_id is null"), 1);
  assert.equal(await scalar('select count(*)::int from fincap_submissions'), 1);
});

test('a failure rolls the whole action back so nothing is half-done', async () => {
  const o = await opp(); await sup();
  await pg.exec('savepoint sp');
  await pg.exec('alter table fincap_submissions add constraint boom check (false) not valid');
  await as(MEMBER);
  await rej(() => passShare(ORG, o), /./);
  await sup(); await pg.exec('rollback to savepoint sp');
  assert.equal(await scalar('select count(*)::int from pursue_decisions'), 0, 'no orphan pass without a submission');
  assert.equal(await scalar('select count(*)::int from opportunity_activity'), 0);
});

test('a second organization sharing the same grant joins the one submission', async () => {
  const o = await opp(); await as(MEMBER); await passShare(ORG, o);
  await as(MEMBER2); const r = await passShare(ORG2, o); await sup();
  assert.equal(r.already_submitted, true);
  assert.equal(await scalar('select count(*)::int from fincap_submissions'), 1);
  assert.equal(await scalar('select count(*)::int from fincap_submission_shares'), 2);
  assert.equal(await scalar('select count(*)::int from pursue_decisions'), 2);
});

test('organization switching and cross-organization submission are blocked', async () => {
  const o = await opp(); await as(MEMBER);
  await rej(() => passShare(ORG2, o), /Not authorized/);
  await as(OUTSIDER); await rej(() => passShare(ORG, o), /Not authorized/);
  await as(MEMBER); await rej(() => pg.query('select * from fincap_my_shares($1)', [ORG2]), /Not authorized/);
  await passShare(ORG, o);
  const mine = await pg.query('select * from fincap_my_shares($1)', [ORG]);
  assert.equal(mine.rows.length, 1); assert.equal(mine.rows[0].status, 'pending_review');
  await as(MEMBER2); assert.equal((await pg.query('select * from fincap_my_shares($1)', [ORG2])).rows.length, 0, "another org's shares are not visible");
});

test('a new funding cycle is a new submission; the same cycle is not', async () => {
  const prog = await scalar('insert into funding_programs default values returning id');
  const c1 = await scalar("insert into funding_cycles(cycle_key) values('2026') returning id");
  const c2 = await scalar("insert into funding_cycles(cycle_key) values('2027') returning id");
  const o1 = await opp({ funding_program_id: prog, source_cycle_id: c1 });
  const o1b = await opp({ funding_program_id: prog, source_cycle_id: c1, title: 'Same cycle re-listed' });
  const o2 = await opp({ funding_program_id: prog, source_cycle_id: c2 });
  await as(MEMBER); await passShare(ORG, o1); await passShare(ORG, o1b); await passShare(ORG, o2); await sup();
  assert.equal(await scalar('select count(*)::int from fincap_submissions'), 2);
});

test('only an administrator can review, edit, approve or list', async () => {
  const o = await opp(); await as(MEMBER); await passShare(ORG, o); await sup();
  const s = await submissionFor(o);
  await as(MEMBER);
  await rej(() => pg.query("select fincap_admin_list('pending_review')"), /Administrator required/);
  await rej(() => edit(s.id, GOOD, s.version), /Administrator required/);
  await rej(() => decide(s.id, 'approve', null, s.version), /Administrator required/);
  await rej(() => pg.query("select fincap_record_issue('2026-10-10', '{}')"), /Administrator required/);
  await rej(() => pg.query('select fincap_public_list()'), /permission denied/);
  await rej(() => pg.query("select fincap_newsletter_export('2026-10-10')"), /permission denied/);
  await as(ADMIN); assert.equal((await pg.query("select jsonb_array_length(fincap_admin_list('pending_review')) n")).rows[0].n, 1);
});

test('approval requires a complete, original, organization-neutral summary', async () => {
  const o = await opp(); await as(MEMBER); await passShare(ORG, o); await as(ADMIN);
  let s = await submissionFor(o);
  await rej(() => decide(s.id, 'approve', null, s.version), /original summary/);
  let e = await edit(s.id, { summary: `${ORG_NAME} should apply because the program matches our mission and our fit score is high.` }, s.version);
  await rej(() => decide(s.id, 'approve', null, e.version), /organization that passed|organization-specific|neutral/);
  e = await edit(s.id, { summary: 'We recommend this grant for our organization because it matches our programs well enough.' }, e.version);
  await rej(() => decide(s.id, 'approve', null, e.version), /organization-specific/);
  e = await edit(s.id, { ...GOOD, source_url: 'javascript:alert(1)' }, e.version);
  await rej(() => decide(s.id, 'approve', null, e.version), /source link/);
  e = await edit(s.id, { ...GOOD, source_url: 'https://example.org/grants/money' }, e.version);
  const d = await decide(s.id, 'approve', null, e.version);
  assert.equal(d.status, 'approved');
});

test('edit allowlist and optimistic versions are enforced', async () => {
  const o = await opp(); await as(MEMBER); await passShare(ORG, o); await as(ADMIN);
  const s = await submissionFor(o);
  await rej(() => edit(s.id, { org_id: ORG }, s.version), /cannot be edited/);
  await rej(() => edit(s.id, { published: { x: 1 } }, s.version), /cannot be edited/);
  await edit(s.id, { geography: 'Florida only' }, s.version);
  await rej(() => edit(s.id, { geography: 'Georgia' }, s.version), /changed/);
});

test('pending and rejected content never reaches any public path', async () => {
  const pending = await opp({ title: 'PENDING-ONLY' }); const rejected = await opp({ title: 'REJECTED-ONLY', source_url: 'https://example.org/other' });
  await as(MEMBER); await passShare(ORG, pending); await passShare(ORG, rejected); await as(ADMIN);
  const r = await submissionFor(rejected); await decide(r.id, 'reject', 'Not relevant to practitioners', r.version);
  await service();
  const list = JSON.stringify((await pg.query('select * from fincap_public_list()')).rows);
  const ex = JSON.stringify((await pg.query("select fincap_newsletter_export('2026-10-10') e")).rows);
  for (const bad of ['PENDING-ONLY', 'REJECTED-ONLY']) { assert.ok(!list.includes(bad)); assert.ok(!ex.includes(bad)); }
  await as(ADMIN); await rej(() => decide(r.id, 'approve', null, r.version + 1), /Only pending or approved/);
});

test('no private field leaks through the public list or newsletter export', async () => {
  const o = await opp();
  const item = await scalar("insert into pipeline_items(org_id,opportunity_id,title,stage,notes) values($1,$2,'t','Reviewing',$3) returning id", [ORG, o, SECRET_NOTE]);
  await pg.query("update pursue_decisions set reason=$1", [SECRET_REASON]);
  await as(MEMBER); await passShare(ORG, o, item);
  await sup(); await pg.query("update pursue_decisions set reason=$1", [SECRET_REASON]);
  await pg.query("update opportunity_activity set detail = detail || $1", [' ' + SECRET_NOTE]);
  await as(ADMIN); const s = await submissionFor(o); const e = await edit(s.id, GOOD, s.version); await decide(s.id, 'approve', null, e.version);
  await service();
  const list = (await pg.query('select * from fincap_public_list()')).rows;
  const ex = (await pg.query("select fincap_newsletter_export('2026-10-10') e")).rows[0].e;
  assert.equal(list.length, 1); assert.equal(ex.items.length, 1);
  const all = JSON.stringify([list, ex]);
  for (const secret of [SECRET_NOTE, SECRET_REASON, 'ORG-SPECIFIC-AI-SUMMARY', ORG_NAME, ORG, MEMBER, 'Pass', 'funder prose', 'headline', 'org_id']) assert.ok(!all.includes(secret), `leaked: ${secret}`);
  const allowed = ['id', 'title', 'funder', 'source_url', 'amount_text', 'deadline', 'deadline_tz', 'deadline_kind', 'deadline_verified', 'eligible_applicants', 'geography', 'program_areas', 'summary', 'last_verified_on', 'status', 'recheck_pending', 'published_at', 'updated_at'];
  assert.deepEqual(Object.keys(list[0]).sort(), allowed.slice().sort());
  assert.notEqual(list[0].id, s.id, 'public id differs from the internal id');
});

test('approval and withdrawal update the list and the export together', async () => {
  const o = await opp(); const p = await publish(o); await service();
  assert.equal((await pg.query('select * from fincap_public_list()')).rows.length, 1);
  assert.equal((await pg.query("select fincap_newsletter_export('2026-10-10') e")).rows[0].e.items.length, 1);
  await as(ADMIN); await rej(() => decide(p.id, 'withdraw', '', p.version), /reason is required/);
  await decide(p.id, 'withdraw', 'Funder closed the program', p.version); await service();
  assert.equal((await pg.query('select * from fincap_public_list()')).rows.length, 0);
  assert.equal((await pg.query("select fincap_newsletter_export('2026-10-10') e")).rows[0].e.items.length, 0);
  await sup();
  assert.equal(await scalar('select count(*)::int from fincap_review_events'), 4, 'submitted, edited, approve, withdraw retained');
  assert.equal(await scalar('select count(*)::int from fincap_submissions'), 1, 'history retained after withdrawal');
});

test('rolling and unknown deadlines are flagged, never invented', async () => {
  const roll = await opp({ title: 'Rolling Grant', deadline: null, source_url: 'https://example.org/roll' });
  const unk = await opp({ title: 'Unknown Date Grant', deadline: null, source_url: 'https://example.org/unk' });
  const unv = await opp({ title: 'Unverified Date Grant', deadline_verified: false, source_url: 'https://example.org/unv' });
  await as(MEMBER); for (const x of [roll, unk, unv]) await passShare(ORG, x); await as(ADMIN);
  let s = await submissionFor(roll); let e = await edit(s.id, { ...GOOD, deadline_kind: 'rolling' }, s.version); await decide(s.id, 'approve', null, e.version);
  s = await submissionFor(unk); e = await edit(s.id, GOOD, s.version); await decide(s.id, 'approve', null, e.version);
  s = await submissionFor(unv); e = await edit(s.id, GOOD, s.version); await decide(s.id, 'approve', null, e.version);
  await service();
  const rows = Object.fromEntries((await pg.query('select * from fincap_public_list()')).rows.map((r) => [r.title, r]));
  assert.equal(rows['Rolling Grant'].status, 'rolling'); assert.equal(rows['Rolling Grant'].deadline, null);
  assert.equal(rows['Unknown Date Grant'].status, 'date_unconfirmed'); assert.equal(rows['Unknown Date Grant'].deadline, null);
  const items = Object.fromEntries((await pg.query("select fincap_newsletter_export('2026-10-10') e")).rows[0].e.items.map((i) => [i.title, i]));
  assert.match(items['Rolling Grant'].deadline_flag, /Rolling/);
  assert.match(items['Unknown Date Grant'].deadline_flag, /not confirmed/);
  assert.match(items['Unverified Date Grant'].deadline_flag, /not verified/);
  assert.equal(items['Unknown Date Grant'].deadline, null);
});

test('unverified amounts are not published; a past deadline cannot be approved', async () => {
  const o = await opp({ amount_verified: false });
  const past = await opp({ deadline: '2026-01-05', source_url: 'https://example.org/past' });
  const p = await publish(o); await service();
  assert.equal((await pg.query('select amount_text from fincap_public_list()')).rows[0].amount_text, null);
  await as(MEMBER); await passShare(ORG, past); await as(ADMIN); const s = await submissionFor(past); const e = await edit(s.id, GOOD, s.version);
  await rej(() => decide(s.id, 'approve', null, e.version), /already passed/);
});

test('expiry and the time zone boundary are exact', async () => {
  const o = await opp({ deadline: '2026-12-15' }); await publish(o); await service();
  const at = (ts) => pg.query('select count(*)::int n from fincap_public_list($1)', [ts]).then((r) => r.rows[0].n);
  assert.equal(await at('2026-12-16T04:30:00Z'), 1, '11:30 pm on the 15th in New York is still open');
  assert.equal(await at('2026-12-16T05:00:01Z'), 0, 'midnight in New York ends the 15th');
  await sup(); await pg.query("update fincap_submissions set published = jsonb_set(published, '{deadline_tz}', '\"America/Los_Angeles\"')");
  await service();
  assert.equal(await at('2026-12-16T05:00:01Z'), 1, 'the same instant is still the 15th in Los Angeles');
  assert.equal(await at('2026-12-16T08:00:01Z'), 0);
  const ex = (d, asof) => pg.query('select fincap_newsletter_export($1,null,$2) e', [d, asof]).then((r) => r.rows[0].e.items.length);
  assert.equal(await ex('2026-12-15', null), 1, 'open on its deadline day');
  assert.equal(await ex('2026-12-16', null), 0, 'expired the day after');
});

test('a material source change flags the publication without editing it', async () => {
  const o = await opp(); const p = await publish(o);
  await pg.query("update opportunities set deadline='2027-02-01', title='Changed Title' where id=$1", [o]);
  const s = (await pg.query('select needs_review, published->>\'title\' t, (published->>\'deadline\') d from fincap_submissions')).rows[0];
  assert.equal(s.needs_review, true); assert.equal(s.t, 'Community Money Grant'); assert.equal(s.d, '2026-12-15');
  await pg.query('update opportunities set source_verified_at=now() where id=$1', [o]);
  await service();
  const ex = (await pg.query("select fincap_newsletter_export('2026-10-10') e")).rows[0].e;
  assert.equal(ex.items.length, 0); assert.equal(ex.held_for_recheck.length, 1);
  assert.equal((await pg.query('select recheck_pending from fincap_public_list()')).rows[0].recheck_pending, true);
  await as(ADMIN); const cur = await submissionFor(o); const e = await edit(cur.id, { title: 'Changed Title', deadline: '2027-02-01' }, cur.version);
  const d = await decide(cur.id, 'approve', null, e.version);
  assert.equal(d.published_version, 2);
  await service(); assert.equal((await pg.query("select fincap_newsletter_export('2026-10-10') e")).rows[0].e.items.length, 1);
  await sup(); assert.equal(await scalar('select needs_review from fincap_submissions'), false);
});

test('an unrelated source refresh does not flag anything', async () => {
  const o = await opp(); await publish(o);
  await pg.query("update opportunities set title=title, deadline=deadline where id=$1", [o]);
  assert.equal(await scalar('select needs_review from fincap_submissions'), false);
});

test('newsletter: export is read-only, history prevents repeats, updates and reminders return', async () => {
  const o = await opp(); const p = await publish(o); await service();
  await sup();
  const before = [await scalar('select count(*)::int from fincap_issues'), await scalar('select count(*)::int from fincap_issue_items')];
  await service();
  const first = (await pg.query("select fincap_newsletter_export('2026-10-10') e")).rows[0].e;
  assert.equal(first.items[0].include_reason, 'new');
  await pg.query("select fincap_newsletter_export('2026-10-10')");
  await sup();
  assert.deepEqual([await scalar('select count(*)::int from fincap_issues'), await scalar('select count(*)::int from fincap_issue_items')], before, 'export writes nothing and never marks an issue sent');
  // Record the issue as finalized (not sent).
  await as(ADMIN);
  await rej(() => pg.query("select fincap_record_issue('2026-10-10', $1)", [[crypto.randomUUID()]]), /not currently published/);
  const rec = (await pg.query("select fincap_record_issue('2026-10-10', $1, 'draft finalized') r", [[first.items[0].id]])).rows[0].r;
  assert.equal(rec.sent, false); assert.equal(rec.items_recorded, 1);
  await sup(); assert.equal(await scalar("select sent_at is null from fincap_issues where issue_date='2026-10-10'"), true);
  await service();
  const next = async (d, rep) => (await pg.query('select fincap_newsletter_export($1,$2) e', [d, rep])).rows[0].e;
  assert.equal((await next('2026-11-10')).items.length, 0, 'not repeated by accident');
  assert.equal((await next('2026-11-10')).previously_included_count, 1);
  assert.equal((await next('2026-12-10', 3)).items.length, 0, 'reminder window not reached');
  const rem = await next('2026-12-10', 14);
  assert.equal(rem.items[0].include_reason, 'deadline_reminder');
  assert.equal((await next('2026-10-10')).items.length, 1, 're-exporting the same issue keeps its items');
  // Material update returns it as updated.
  await as(ADMIN); const cur = await submissionFor(o); const e = await edit(cur.id, { summary: GOOD.summary + ' Applications now include a short video.' }, cur.version);
  await decide(cur.id, 'approve', 'Summary refreshed', e.version); await service();
  assert.equal((await next('2026-11-10')).items[0].include_reason, 'updated');
});

test('newsletter excludes expired and respects the cutoff', async () => {
  const o = await opp({ deadline: '2026-10-12' }); await publish(o); await service();
  assert.equal((await pg.query("select fincap_newsletter_export('2026-10-10') e")).rows[0].e.items.length, 1);
  assert.equal((await pg.query("select fincap_newsletter_export('2026-10-13') e")).rows[0].e.items.length, 0);
  assert.equal((await pg.query("select fincap_newsletter_export('2026-09-01') e")).rows[0].e.items.length, 0, 'approved after the cutoff');
});
