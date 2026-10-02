'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../netlify/functions/fincap-feed.js');
const { handle, toMarkdown } = _test;

const PRIVATE = { org_id: 'ORG-SECRET', notes: 'PRIVATE-NOTE', ai_summary: 'ORG-SPECIFIC', reason: 'PRIVATE-REASON', fit_score: 88, internal_id: 'INTERNAL', shared_by_orgs: ['Sunrise'] };
const row = (o = {}) => ({ id: 'p1', title: 'Grant', funder: 'Funder', source_url: 'https://funder.example/apply', amount_text: null, deadline: '2026-12-15', deadline_tz: 'America/New_York',
  deadline_kind: 'fixed', deadline_verified: true, eligible_applicants: 'Nonprofits', geography: 'Florida only', program_areas: ['Financial capability'], summary: 'Original neutral summary of the grant.',
  last_verified_on: '2026-09-30', status: 'open', recheck_pending: false, published_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...PRIVATE, ...o });
function deps(rowsOrExport, calls = []) {
  return { url: 'https://db.example', key: 'service-key', fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => rowsOrExport }; } };
}
const get = (q, d) => handle({ httpMethod: 'GET', queryStringParameters: q }, d);

test('opportunities feed returns only allowlisted fields and never private ones', async () => {
  const calls = []; const r = await get({ view: 'opportunities' }, deps([row()], calls));
  assert.equal(r.statusCode, 200);
  const out = JSON.parse(r.body).opportunities[0];
  for (const k of Object.keys(PRIVATE)) assert.ok(!(k in out), k);
  assert.ok(!r.body.includes('ORG-SECRET') && !r.body.includes('PRIVATE-NOTE') && !r.body.includes('ORG-SPECIFIC'));
  assert.equal(calls.length, 1); assert.match(calls[0].url, /rpc\/fincap_public_list$/); assert.equal(calls[0].body.p_limit, 200);
});
test('responses are cacheable and public, errors are not cached', async () => {
  const ok = await get({ view: 'opportunities' }, deps([]));
  assert.match(ok.headers['Cache-Control'], /s-maxage=300/); assert.equal(ok.headers['Access-Control-Allow-Origin'], '*');
  const bad = await get({ view: 'opportunities' }, { ...deps([]), fetch: async () => ({ ok: false, status: 500 }) });
  assert.equal(bad.statusCode, 502); assert.equal(bad.headers['Cache-Control'], 'no-store'); assert.ok(!bad.body.includes('db.example'));
});
test('a javascript: or malformed source link is dropped', async () => {
  const r = await get({ view: 'opportunities' }, deps([row({ source_url: 'javascript:alert(1)' })]));
  assert.equal(JSON.parse(r.body).opportunities[0].source_url, null);
});
test('newsletter export validates input, strips private data and stays read-only', async () => {
  assert.equal((await get({ view: 'newsletter' }, deps({}))).statusCode, 400);
  assert.equal((await get({ view: 'newsletter', issue: '2026-13-45' }, deps({}))).statusCode, 400);
  assert.equal((await get({ view: 'newsletter', issue: '2026-10-10', repeat_within_days: '999' }, deps({}))).statusCode, 400);
  const calls = [];
  const raw = { issue_date: '2026-10-10', items: [{ ...row(), include_reason: 'new', deadline_flag: null }], held_for_recheck: [{ id: 'h', title: 'Held', reason: 'x', ...PRIVATE }], previously_included_count: 2 };
  const r = await get({ view: 'newsletter', issue: '2026-10-10', repeat_within_days: '14' }, deps(raw, calls));
  const out = JSON.parse(r.body);
  assert.equal(out.items.length, 1); assert.ok(!r.body.includes('ORG-SECRET') && !r.body.includes('PRIVATE'));
  assert.deepEqual(calls.map((c) => c.url.split('/').pop()), ['fincap_newsletter_export']);
  assert.equal(calls[0].body.p_repeat_deadline_days, 14);
  assert.ok(!('reason' in out.held_for_recheck[0]));
});
test('markdown export flags uncertain deadlines and never invents one', async () => {
  const raw = { issue_date: '2026-10-10', items: [
    { ...row({ deadline: null, deadline_kind: 'unknown' }), include_reason: 'new', deadline_flag: 'Deadline not confirmed. Do not state a date.' },
    { ...row({ title: 'Rolling', deadline: null, deadline_kind: 'rolling' }), include_reason: 'updated', deadline_flag: 'Rolling: no fixed deadline. Check the funder.' },
    { ...row({ title: 'Fixed' }), include_reason: 'deadline_reminder', deadline_flag: null }], held_for_recheck: [], previously_included_count: 0 };
  const md = (await get({ view: 'newsletter', issue: '2026-10-10', format: 'md' }, deps(raw))).body;
  assert.match(md, /Deadline: Deadline not confirmed/); assert.match(md, /Rolling \(no fixed deadline\)/); assert.match(md, /December 15, 2026 \(New York time\)/);
  assert.match(md, /Who can apply: Nonprofits/); assert.match(md, /Where: Florida only/); assert.match(md, /\(Deadline reminder\)/);
  assert.ok(!md.includes('ORG-SECRET'));
});
test('only GET is accepted and missing configuration fails closed', async () => {
  assert.equal((await handle({ httpMethod: 'POST' }, deps([]))).statusCode, 405);
  assert.equal((await get({ view: 'opportunities' }, { url: '', key: '', fetch: async () => { throw new Error('should not call'); } })).statusCode, 500);
  assert.equal((await get({ view: 'nope' }, deps([]))).statusCode, 400);
});
