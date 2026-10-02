'use strict';
// Browser check of the Pass & Share UI and FinCap Review screen against a FAKE
// Supabase client and synthetic data. Never contacts production.
//   node scripts/fincap-ui-check.cjs [screenshot-dir]
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const shots = process.argv[2];
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };

const FAKE_SDK = `
window.__calls = [];
window.__cfg = window.__cfg || {};
(function () {
  var fx = window.__fixtures;
  function run(st) {
    var rows = (fx[st.table] || []).slice();
    st.filters.forEach(function (f) { rows = rows.filter(function (r) { return r[f[0]] === f[1]; }); });
    if (st.op === 'insert' || st.op === 'update' || st.op === 'delete') window.__calls.push({ table: st.table, op: st.op, payload: st.payload });
    if (st.op === 'insert') { var row = Object.assign({ id: 'new-' + window.__calls.length, decided_at: new Date().toISOString() }, st.payload); return { data: row, error: null }; }
    if (st.mode === 'single' || st.mode === 'maybe') return { data: rows[0] || null, error: rows[0] || st.mode === 'maybe' ? null : { message: 'none' } };
    return { data: rows, error: null };
  }
  function qb(table) {
    var st = { table: table, filters: [], mode: 'many' };
    var b = new Proxy({}, { get: function (_, k) {
      if (k === 'then') return function (res, rej) { return Promise.resolve(run(st)).then(res, rej); };
      return function () {
        var a = Array.prototype.slice.call(arguments);
        if (k === 'eq') st.filters.push(a);
        if (k === 'insert' || k === 'update') { st.op = k; st.payload = a[0]; }
        if (k === 'delete') st.op = 'delete';
        if (k === 'single') st.mode = 'single';
        if (k === 'maybeSingle') st.mode = 'maybe';
        return b;
      };
    } });
    return b;
  }
  var session = { user: { id: 'u1', email: 'tester@example.test' }, access_token: 't' };
  window.supabase = { createClient: function () { return {
    auth: { getSession: function () { return Promise.resolve({ data: { session: session } }); }, onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; }, signOut: function () { return Promise.resolve({}); } },
    from: qb,
    rpc: function (name, args) {
      window.__calls.push({ rpc: name, args: args });
      var h = window.__rpc[name];
      return Promise.resolve(h ? h(args) : { data: null, error: null });
    }
  }; } };
})();`;

function fixtures(admin) {
  const orgA = { id: 'orgA', name: 'Synthetic Youth Org', programs: 'financial literacy', service_areas: 'Florida', keywords: [], naics_codes: [], target_populations: 'youth' };
  const orgB = { id: 'orgB', name: 'Synthetic Second Org', programs: 'workforce', service_areas: 'Florida', keywords: [], naics_codes: [], target_populations: 'adults' };
  const o = (id, title, deadline) => ({ id, title, source: 'Example Funder', source_url: 'https://example.org/' + id, summary: 'Synthetic description for ' + title + '.', geography: 'Florida', category: 'Financial capability', funding_amount_label: 'Up to $25,000', deadline, source_active: true });
  return {
    profiles: [{ id: 'u1', org_id: 'orgA' }], organizations: [orgA, orgB],
    opportunities: [o('o1', 'Synthetic Money Skills Grant', '2027-03-01'), o('o2', 'Synthetic Workforce Fund', '2027-04-01'), o('o3', 'Synthetic Family Stability Award', '2027-05-01')],
    pipeline_items: [{ id: 'p2', org_id: 'orgA', opportunity_id: 'o2', title: 'Synthetic Workforce Fund', stage: 'Reviewing', notes: null, opportunities: { funding_amount_label: 'Up to $25,000', deadline: '2027-04-01', category: 'Financial capability' } }],
    subscriptions: [{ org_id: 'orgA', status: 'active', plan: 'pro' }],
    admins: admin ? [{ profile_id: 'u1' }] : [], fit_scores: ['o1', 'o2', 'o3'].map((id, i) => ({ opportunity_id: id, headline_score: 85 - i * 5, recommendation: 'Strongly pursue', factors: [], confidence: 0.8, rubric_version: '2026-09-25.1', eligibility_status: 'ELIGIBLE', eligibility_reasons: [], source_stale: false })), pursue_decisions: [], requirements: [], contracts: [], alert_rules: [], foundation_scan_hits: [], funder_watchlist: []
  };
}
const DRAFT = 'Example Funder supports nonprofits in Florida that teach practical money skills to young adults through coaching and workshops.';
const RPC = `window.__rpc = {
  my_organizations: function () { return { data: window.__fixtures.organizations.map(function (o) { return { id: o.id, name: o.name }; }), error: null }; },
  set_active_org: function (a) { window.__fixtures.profiles[0].org_id = a.p_org; return { data: null, error: null }; },
  fincap_my_shares: function () { return { data: [], error: null }; },
  fincap_pass_and_share: function (a) {
    if (window.__cfg.fail) return { data: null, error: { message: 'simulated outage' } };
    window.__shared = (window.__shared || 0) + 1;
    return new Promise(function (r) { setTimeout(function () { r({ data: { decision_id: 'd1', submission_status: 'pending_review', needs_review: false, created: window.__shared === 1, already_submitted: window.__shared > 1 }, error: null }); }, window.__cfg.delay || 50); });
  },
  fincap_admin_list: function () { return { data: [{ id: 's1', public_id: 'pub1', status: 'pending_review', needs_review: false, version: 1, published_version: 0, has_unpublished_edits: false, cycle_key: 'deadline-2027',
    draft: { title: 'Synthetic Money Skills Grant', funder: 'Example Funder', source_url: 'https://example.org/o1', amount_text: null, amount_verified: false, deadline: '2027-03-01', deadline_tz: 'America/New_York', deadline_kind: 'fixed', deadline_verified: true, eligible_applicants: null, geography: 'Florida', program_areas: ['Financial capability'], summary: null, last_verified_on: '2026-09-30' },
    problem: 'Write an original summary of at least 40 characters.', shared_by_orgs: ['Synthetic Youth Org'], created_at: '2026-10-01', updated_at: '2026-10-01' }], error: null }; },
  fincap_admin_edit: function () { return { data: { version: 2, status: 'pending_review', problem: null }, error: null }; },
  fincap_admin_decide: function () { return { data: { status: 'approved', version: 3, published_version: 1 }, error: null }; }
};`;

(async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname === '/' ? '/app.html' : u.pathname;
    const f = path.resolve(root, '.' + p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  let passed = 0;
  const ok = (name) => { passed++; console.log('ok - ' + name); };

  async function open(opts = {}) {
    const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.includes('/.netlify/functions/fincap-draft-summary')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ summary: DRAFT, eligible_applicants: '501(c)(3) nonprofits', geography: 'Statewide (should not replace Florida)' }) });
      if (url.includes('/.netlify/functions/score-opportunities') && opts.dropFit) return new Promise((r) => setTimeout(r, 1500)).then(() => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [] }) }));
      if (url.startsWith(base)) return url.includes('/.netlify/') ? route.fulfill({ status: 200, body: '{}' }) : route.continue();
      const fx = fixtures(!!opts.admin); if (opts.dropFit) fx.fit_scores = fx.fit_scores.slice(0, 2);
      if (url.includes('supabase-js')) return route.fulfill({ contentType: 'text/javascript', body: `window.__fixtures=${JSON.stringify(fx)};${RPC}${FAKE_SDK}` });
      return route.abort();
    });
    await page.addInitScript('window.__cfg = ' + JSON.stringify(opts.cfg || {}) + ';');
    page.on('dialog', (d) => d.accept());
    await page.goto(base + '/');
    await page.waitForSelector('#nav', { timeout: 10000 });
    return { page, ctx, errors };
  }
  const calls = (page) => page.evaluate(() => window.__calls);

  // 1. Ordinary Pass and Qualify (Pursue) keep their behavior; no FinCap call.
  {
    const { page, ctx, errors } = await open();
    await page.waitForSelector('[data-act="share"]');
    assert.deepEqual(await page.$$eval('#needsDecision [data-act]', (b) => b.slice(0, 3).map((x) => x.textContent.trim())), ['Pursue', 'Pass', 'Pass & Share with FinCap']);
    if (shots) await page.screenshot({ path: path.join(shots, '01-dashboard-three-actions.png') });
    await page.click('#needsDecision [data-act="pass"]');
    await page.waitForTimeout(200);
    const c = await calls(page);
    assert.equal(c.filter((x) => x.table === 'pursue_decisions' && x.op === 'insert' && x.payload.decision === 'pass').length, 1);
    assert.equal(c.filter((x) => x.rpc === 'fincap_pass_and_share').length, 0, 'ordinary Pass never touches FinCap');
    ok('ordinary Pass writes one private decision and does not share');
    await ctx.close(); assert.deepEqual(errors, []);
  }
  {
    const { page, ctx } = await open();
    await page.click('#needsDecision [data-act="pursue"]'); await page.waitForTimeout(200);
    const c = await calls(page);
    assert.equal(c.filter((x) => x.table === 'pursue_decisions' && x.payload && x.payload.decision === 'pursue').length, 1);
    assert.equal(c.filter((x) => x.table === 'pipeline_items' && x.op === 'insert').length, 1);
    ok('Qualify (Pursue) still adds to the pipeline');
    await ctx.close();
  }
  // 2. Pass & Share: one RPC even on a double click; status shown.
  {
    const { page, ctx, errors } = await open({ cfg: { delay: 300 } });
    const before = await page.$$eval('#needsDecision .opp', (r) => r.length);
    await page.dblclick('#needsDecision [data-act="share"]');
    await page.waitForSelector('.toast');
    const c = await calls(page);
    assert.equal(c.filter((x) => x.rpc === 'fincap_pass_and_share').length, 1, 'double click sends one request');
    assert.equal(c.find((x) => x.rpc === 'fincap_pass_and_share').args.p_org, 'orgA');
    assert.match(await page.textContent('.toast'), /Pending editorial review/);
    assert.equal(c.filter((x) => x.table === 'pursue_decisions').length, 0, 'no separate browser writes');
    assert.equal(await page.$$eval('#needsDecision .opp', (r) => r.length), before - 1);
    if (shots) await page.screenshot({ path: path.join(shots, '02-after-pass-and-share.png') });
    ok('Pass & Share sends exactly one server request on a double click and shows pending review');
    await ctx.close(); assert.deepEqual(errors, []);
  }
  // 3. Failure: nothing is recorded, user is told, button usable again.
  {
    const { page, ctx } = await open({ cfg: { fail: true } });
    const before = await page.$$eval('#needsDecision .opp', (r) => r.length);
    await page.click('#needsDecision [data-act="share"]');
    await page.waitForSelector('.toast.err');
    assert.match(await page.textContent('.toast.err'), /Nothing was shared and your decision was not recorded/);
    assert.equal(await page.$$eval('#needsDecision .opp', (r) => r.length), before, 'the grant stays on the list');
    assert.equal(await page.$eval('#needsDecision [data-act="share"]', (b) => b.disabled), false);
    ok('a failed Pass & Share is reported and leaves the grant undecided');
    await ctx.close();
  }
  // 4. Organization switching mid-flight does not leak the result into the other org.
  {
    const { page, ctx, errors } = await open({ cfg: { delay: 600 }, viewport: { width: 1280, height: 900 } });
    await page.click('#needsDecision [data-act="share"]');
    await page.selectOption('#orgSwitch', 'orgB');
    await page.waitForTimeout(1200);
    const c = await calls(page);
    assert.equal(c.find((x) => x.rpc === 'fincap_pass_and_share').args.p_org, 'orgA', 'the request stayed with the organization it started in');
    await page.waitForSelector('#needsDecision');
    assert.equal(await page.$$eval('#needsDecision .opp', (r) => r.length), 2, 'organization B still sees both grants undecided');
    ok('switching organization mid-request does not apply the result to the new organization');
    await ctx.close(); assert.deepEqual(errors, []);
  }
  // 5. Pipeline review page.
  {
    const { page, ctx, errors } = await open();
    await page.click('[data-v="pipeline"]'); await page.click('.pcard');
    await page.waitForSelector('#shareItem');
    assert.deepEqual(await page.$$eval('#qualifyItem, #passItem, #shareItem', (b) => b.map((x) => x.textContent.trim())), ['Qualify: move to Qualified', 'Pass: remove from pipeline', 'Pass & Share with FinCap']);
    if (shots) await page.screenshot({ path: path.join(shots, '03-pipeline-review.png') });
    await page.click('#shareItem'); await page.waitForSelector('.toast');
    const c = await calls(page);
    assert.equal(c.find((x) => x.rpc === 'fincap_pass_and_share').args.p_pipeline_item, 'p2');
    assert.equal(c.filter((x) => x.table === 'pipeline_items' && x.op === 'delete').length, 0, 'the card is removed by the server transaction, not by browser writes');
    assert.equal(await page.$$eval('.pcard', (r) => r.length), 0);
    ok('pipeline review: Pass & Share removes the card through one server call');
    await ctx.close(); assert.deepEqual(errors, []);
  }
  // 6. Admin screen: only for admins.
  {
    const { page, ctx } = await open();
    assert.equal(await page.$('[data-v="fincap"]'), null); ok('non-admins do not see FinCap Review'); await ctx.close();
  }
  {
    const { page, ctx, errors } = await open({ admin: true });
    await page.click('[data-v="fincap"]'); await page.waitForSelector('[data-a="approve"]');
    await page.waitForFunction((t) => document.querySelector('[data-f="summary"]').value === t, DRAFT);
    let c = await calls(page);
    const auto = c.find((x) => x.rpc === 'fincap_admin_edit');
    assert.deepEqual(Object.keys(auto.args.p_fields).sort(), ['eligible_applicants', 'summary'], 'only empty fields are drafted; the existing geography is kept');
    assert.equal(auto.args.p_version, 1);
    assert.equal(await page.inputValue('[data-f="eligible_applicants"]'), '501(c)(3) nonprofits');
    assert.equal(await page.inputValue('[data-f="geography"]'), 'Florida');
    assert.match(await page.textContent('#fc-list'), /Filled in automatically: summary, who can apply/);
    assert.match(await page.textContent('#fc-list'), /Ready to publish/);
    assert.equal(await page.inputValue('[data-f="last_verified_on"]'), '2026-09-30', 'an existing verified date is kept');
    ok('admin review: empty summary and who-can-apply are drafted and saved; filled fields are kept');
    if (shots) await page.screenshot({ path: path.join(shots, '04-admin-review.png'), fullPage: true });
    await page.click('[data-a="approve"]'); await page.waitForTimeout(300);
    c = await calls(page);
    const edit = c.find((x) => x.rpc === 'fincap_admin_edit' && 'title' in x.args.p_fields), dec = c.find((x) => x.rpc === 'fincap_admin_decide');
    assert.equal(edit.args.p_version, 2, 'approval uses the version from the automatic draft'); assert.equal(dec.args.p_version, 2, 'decision uses the version returned by the edit');
    assert.equal(edit.args.p_fields.summary, DRAFT);
    assert.equal(dec.args.p_action, 'approve'); assert.ok(!('org_id' in edit.args.p_fields));
    ok('admin review: edit then approve use optimistic versions');
    await page.click('[data-t="newsletter"]'); await page.waitForSelector('#fc-prev');
    assert.match(await page.inputValue('#fc-issue'), /^\d{4}-\d{2}-10$/);
    ok('newsletter tab defaults to the next 10th');
    await ctx.close(); assert.deepEqual(errors, []);
  }
  // Background fit scoring must not redraw the review screen while an editor types.
  {
    const { page, ctx, errors } = await open({ admin: true, dropFit: true });
    await page.click('[data-v="fincap"]'); await page.waitForSelector('[data-f="eligible_applicants"]');
    await page.fill('[data-f="eligible_applicants"]', 'Typed while scoring runs');
    await page.waitForTimeout(2500);
    assert.equal(await page.inputValue('[data-f="eligible_applicants"]'), 'Typed while scoring runs');
    ok('background scoring does not wipe what an editor is typing');
    await ctx.close(); assert.deepEqual(errors, []);
  }
  // 7. Mobile layout of the new controls.
  {
    const { page, ctx } = await open({ viewport: { width: 390, height: 800 } });
    await page.waitForSelector('[data-act="share"]');
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 1, 'no horizontal page scroll on a phone: ' + over);
    if (shots) await page.screenshot({ path: path.join(shots, '05-mobile-dashboard.png') });
    ok('mobile width has no horizontal overflow'); await ctx.close();
  }
  await browser.close(); server.close();
  console.log(`\n${passed} UI checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
