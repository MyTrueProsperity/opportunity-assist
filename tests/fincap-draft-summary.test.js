'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../netlify/functions/fincap-draft-summary.js');
const { handle, factsFor, tidy } = _test;

const ID = '11111111-2222-3333-4444-555555555555';
const SUB = { id: ID, status: 'pending_review', opportunity_id: 'opp-1', pub_title: 'Community Finance Grant', pub_funder: 'Example Foundation',
  pub_eligible_applicants: 'Nonprofits', pub_geography: 'Florida', pub_program_areas: ['Financial coaching'], pub_deadline_kind: 'fixed' };
const OPP = { title: 'Community Finance Grant', source: 'Example Foundation', summary: 'Supports financial coaching programs for low-income households.', requirements: '501(c)(3) status.', geography: 'Florida', category: 'Financial capability' };
const DRAFT = 'Example Foundation funds nonprofit financial coaching programs that serve low-income households in Florida. Applicants need 501(c)(3) status.';
const reply = (o) => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ summary: DRAFT, eligible_applicants: '501(c)(3) nonprofits', geography: 'Florida', ...o }) }] });

function deps({ admin = true, sub = SUB, opp = OPP, answer, calls = [] } = {}) {
  return {
    url: 'https://db.example', anonKey: 'anon', serviceKey: 'service',
    fetch: async (url, init = {}) => {
      calls.push({ url, auth: (init.headers || {}).Authorization });
      if (/rpc\/fincap_is_admin$/.test(url)) return { ok: true, json: async () => admin };
      if (/fincap_submissions\?/.test(url)) return { ok: true, json: async () => (sub ? [sub] : []) };
      if (/opportunities\?/.test(url)) return { ok: true, json: async () => (opp ? [opp] : []) };
      throw new Error('unexpected ' + url);
    },
    anthropic: { beta: { messages: { create: async (req) => { calls.push({ model: req }); return answer || reply({}); } } } },
  };
}
const post = (body, d, token = 'user-token') => handle({ httpMethod: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body: JSON.stringify(body) }, d);

test('drafts a summary for an administrator and writes nothing', async () => {
  const calls = [];
  const r = await post({ submission_id: ID }, deps({ calls }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { summary: DRAFT, eligible_applicants: '501(c)(3) nonprofits', geography: 'Florida', model: 'claude-opus-5-5' });
  assert.equal(calls[0].auth, 'Bearer user-token'); // admin check runs as the caller
  assert.ok(calls.every((c) => !c.url || !/rpc\/fincap_admin_edit|PATCH/.test(c.url)));
  const req = calls.find((c) => c.model).model;
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.fallbacks, 'default');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.deepEqual(req.output_config.format.schema.required, ['summary', 'eligible_applicants', 'geography']);
});

test('fields the funder did not state come back empty instead of guessed', async () => {
  const r = JSON.parse((await post({ submission_id: ID }, deps({ answer: reply({ eligible_applicants: null, geography: 'Not stated' }) }))).body);
  assert.equal(r.eligible_applicants, null); assert.equal(r.geography, null);
  const long = JSON.parse((await post({ submission_id: ID }, deps({ answer: reply({ geography: 'x'.repeat(200) }) }))).body);
  assert.equal(long.geography, null, 'over-long fields are dropped');
  assert.equal((await post({ submission_id: ID }, deps({ answer: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] } }))).statusCode, 502);
});

test('rejects callers who are not signed in or not administrators', async () => {
  assert.equal((await post({ submission_id: ID }, deps(), '')).statusCode, 401);
  assert.equal((await post({ submission_id: ID }, deps({ admin: false }))).statusCode, 403);
  assert.equal((await post({ submission_id: 'not-a-uuid' }, deps())).statusCode, 400);
});

test('the model never sees private organization data', async () => {
  const calls = [];
  const sub = { ...SUB, shared_by_orgs: ['Sunrise Coaching'], decision_reason: 'PRIVATE' };
  const opp = { ...OPP, ai_summary: 'ORG-SPECIFIC fit analysis', notes: 'PRIVATE-NOTE' };
  await post({ submission_id: ID }, deps({ sub, opp, calls }));
  const sent = JSON.stringify(calls.find((c) => c.model).model);
  for (const secret of ['Sunrise', 'ORG-SPECIFIC', 'PRIVATE-NOTE', 'PRIVATE']) assert.ok(!sent.includes(secret), secret);
  assert.ok(calls.some((c) => c.url && /select=title,source,summary,requirements,geography,category$/.test(c.url)));
});

test('missing source text, refusals and bad lengths ask for a manual summary', async () => {
  assert.equal((await post({ submission_id: ID }, deps({ opp: { ...OPP, summary: ' ' } }))).statusCode, 422);
  assert.equal((await post({ submission_id: ID }, deps({ sub: null }))).statusCode, 404);
  assert.equal((await post({ submission_id: ID }, deps({ answer: { stop_reason: 'refusal', content: [] } }))).statusCode, 422);
  assert.equal((await post({ submission_id: ID }, deps({ answer: reply({ summary: 'Too short.' }) }))).statusCode, 502);
});

test('facts wrap the funder text as untrusted data and tidy strips quotes', () => {
  const f = factsFor(SUB, OPP);
  assert.match(f, /<funder_description>\nSupports financial coaching/);
  assert.match(f, /Who can apply \(already on file\): Nonprofits/);
  assert.equal(tidy('  "A  summary\n here."  '), 'A summary here.');
});
