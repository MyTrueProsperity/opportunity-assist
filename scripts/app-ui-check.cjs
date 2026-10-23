'use strict';
// Browser check of the dashboard, Funding Radar, free estimates, on-request
// scoring, alerts, billing and pipeline requirement hand-off against a FAKE
// Supabase client and synthetic data. Never contacts production.
//   node scripts/app-ui-check.cjs [screenshot-dir]
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const M = require('../assets/matching');

const root = path.resolve(__dirname, '..');
const shots = process.argv[2];
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };

const FAKE_SDK = `
window.__calls = [];
(function () {
  var fx = window.__fixtures;
  function run(st) {
    var rows = (fx[st.table] || []).slice();
    st.filters.forEach(function (f) { rows = rows.filter(function (r) { return r[f[0]] === f[1]; }); });
    if (st.order) rows.sort(function (a, b) { return String(a[st.order]).localeCompare(String(b[st.order])); });
    // Like the real API: at most 1,000 rows per request, honoring .range().
    if (!st.op) rows = st.range ? rows.slice(st.range[0], Math.min(st.range[1] + 1, st.range[0] + 1000)) : rows.slice(0, 1000);
    if (st.op) window.__calls.push({ table: st.table, op: st.op, payload: st.payload });
    if (st.op === 'insert') { var row = Object.assign({ id: 'new-' + window.__calls.length, created_at: new Date().toISOString(), decided_at: new Date().toISOString() }, st.payload); (fx[st.table] = fx[st.table] || []).push(row); return { data: row, error: null }; }
    if (st.op === 'update' || st.op === 'delete') return { data: null, error: null };
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
        if (k === 'order') st.order = a[0];
        if (k === 'range') st.range = a;
        if (k === 'insert' || k === 'update') { st.op = k; st.payload = a[0]; }
        if (k === 'delete') st.op = 'delete';
        if (k === 'single') st.mode = 'single';
        if (k === 'maybeSingle') st.mode = 'maybe';
        return b;
      };
    } });
    return b;
  }
  var session = { user: window.__user, access_token: 't' };
  window.supabase = { createClient: function () { return {
    auth: { getSession: function () { return Promise.resolve({ data: { session: session } }); }, onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; }, signOut: function () { return Promise.resolve({}); } },
    from: qb,
    rpc: function (name) {
      if (name === 'my_organizations') return Promise.resolve({ data: [{ id: 'orgA', name: 'Synthetic Youth Org' }], error: null });
      return Promise.resolve({ data: [], error: null });
    }
  }; } };
})();`;

function fixtures({ subscribed = true, big = false } = {}) {
  const org = { id: 'orgA', name: 'Synthetic Youth Org', programs: 'Youth employment and financial coaching', service_areas: 'Florida', keywords: ['youth employment', 'financial capability'], naics_codes: [], target_populations: 'youth' };
  const opp = (id, title, extra = {}) => ({ id, title, source: 'Example Funder', source_url: 'https://example.org/' + id, summary: 'Synthetic listing.', geography: 'Florida', category: 'Grant Opportunity', requirements: 'Nonprofits', deadline: '2027-03-01', ...extra });
  const relevant = ['Youth Employment Pathways', 'Financial Capability Coaching Fund', 'Summer Youth Employment Grant', 'Financial Capability for Families', 'Youth Employment Innovation'].map((t, i) => opp('rel' + i, t));
  const noise = Array.from({ length: 220 }, (_, i) => opp('noise' + i, 'Janitorial Services Contract ' + i, { category: 'Solicitation' }));
  // A catalog with more fit scores than one API page (1,000 rows).
  const bulk = big ? Array.from({ length: 1200 }, (_, i) => opp('bulk' + String(i).padStart(4, '0'), 'Community Grant ' + i)) : [];
  const scored = (id, score) => ({ org_id: 'orgA', opportunity_id: id, headline_score: score, recommendation: 'Worth reviewing', factors: [], confidence: 0.8, rubric_version: M.RUBRIC_VERSION, eligibility_status: 'ELIGIBLE', source_stale: false });
  const pipe = (id, stage, oppId, amount, category) => ({ id, org_id: 'orgA', opportunity_id: oppId, title: 'Pipeline ' + id, stage, notes: null, sort_order: 0, opportunities: { funding_amount: amount, funding_amount_label: amount ? '$' + amount : null, deadline: '2027-03-01', category } });
  return {
    profiles: [{ id: 'u1', org_id: 'orgA' }],
    organizations: [org],
    opportunities: relevant.concat(noise, bulk),
    fit_scores: [scored('rel0', 82), scored('rel1', 64)].concat(bulk.map((o) => scored(o.id, 55))),
    pipeline_items: [pipe('p1', 'Ideas', 'rel2', null, 'Grant Opportunity'), pipe('p2', 'Qualified', 'rel3', 50000, 'Foundation Grant'), pipe('p3', 'Awarded', 'rel4', 25000, 'Grant Opportunity'), pipe('p4', 'Not Awarded', null, null, null)],
    subscriptions: subscribed ? [{ org_id: 'orgA', status: 'active', plan: 'professional' }] : [],
    admins: [], contracts: [], alert_rules: [], requirements: [], pursue_decisions: [],
  };
}

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
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    const scoredIds = [];
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.includes('/.netlify/functions/score-opportunities')) {
        const ids = JSON.parse(route.request().postData()).opportunity_ids;
        scoredIds.push(...ids);
        await new Promise((r) => setTimeout(r, opts.scoreDelay || 0));
        if (opts.failBatches && ids.length > 1) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'simulated model outage' }) });
        const results = ids.map((id) => ({ opportunity_id: id, headline_score: 70, recommendation: 'Worth reviewing', factors: [], confidence: 0.7, rubric_version: M.RUBRIC_VERSION, eligibility_status: 'ELIGIBLE', eligibility_reasons: [] }));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results, failed: [] }) });
      }
      if (url.startsWith(base)) return url.includes('/.netlify/') ? route.fulfill({ status: 200, body: '{}' }) : route.continue();
      if (url.includes('supabase-js')) {
        const user = { id: 'u1', email: opts.guest ? null : 'tester@example.test', is_anonymous: !!opts.guest };
        return route.fulfill({ contentType: 'text/javascript', body: `window.__user=${JSON.stringify(user)};window.__fixtures=${JSON.stringify(fixtures(opts))};${FAKE_SDK}` });
      }
      return route.abort();
    });
    page.on('dialog', (d) => d.accept());
    await page.goto(base + '/');
    await page.waitForSelector('#nav', { timeout: 10000 });
    return { page, ctx, errors, scoredIds };
  }
  const text = (page, sel) => page.textContent(sel);

  // 1. Dashboard: open pipeline, known value with coverage, stage line, win rate, funding mix.
  {
    const { page, ctx, errors, scoredIds } = await open();
    await page.waitForTimeout(400);
    const body = await text(page, '#main');
    assert.match(body, /2\s*Open in Capture Pipeline/);
    assert.match(body, /\$50,000\s*Known pipeline value \(1 of 2 state an amount\)/);
    assert.match(body, /Pipeline by stage: Ideas 1 · Qualified 1 · Awarded 1 · Not Awarded 1/);
    assert.match(body, /Win rate: 50% \(1 awarded of 2 decided, \$25,000 awarded\)/);
    assert.match(body, /Funding mix \(open items\): (Grant Opportunity 1 · Foundation Grant 1|Foundation Grant 1 · Grant Opportunity 1)/);
    if (shots) await page.screenshot({ path: path.join(shots, '01-dashboard.png'), fullPage: true });
    ok('dashboard shows open pipeline, honest known value, stage counts, win rate and funding mix');
    await page.waitForTimeout(1500);
    assert.ok(!scoredIds.includes('rel0') && !scoredIds.includes('rel1'), 'current AI scores are not bought again');
    assert.equal(new Set(scoredIds).size, scoredIds.length, 'no lead is sent twice');
    ok('automatic scoring requests only leads without a current AI score, once each');
    await ctx.close(); assert.deepEqual(errors, []);
  }
  // 1b. More than 1,000 stored scores: none are bought again on the next visit.
  {
    const { page, ctx, errors, scoredIds } = await open({ big: true });
    await page.waitForTimeout(3000);
    assert.equal(scoredIds.filter((id) => id.startsWith('bulk')).length, 0, 'scores past the first 1,000 rows are loaded, not re-bought');
    ok('fit scores beyond the 1,000-row API page are loaded instead of re-scored');
    await ctx.close(); assert.deepEqual(errors, []);
  }

  // 2. Funding Radar: paging, estimates marked "~", and filters survive the background repaint.
  {
    const { page, ctx, errors } = await open({ scoreDelay: 1500 });
    await page.click('[data-v="radar"]');
    await page.waitForSelector('#list .opp');
    assert.equal(await page.$$eval('#list > .opp', (r) => r.length), 100, 'first page only');
    assert.match(await text(page, '#list'), /Show 100 more of 125 remaining/);
    const firstScores = await page.$$eval('#list > .opp .score-num', (r) => r.slice(0, 2).map((x) => x.textContent));
    assert.deepEqual(firstScores, ['82%', '64%'], 'real AI scores rank above keyword estimates');
    // Scores arrive in the background; before they do, estimates carry "~" and
    // listings with no keyword match show no number rather than a fake one.
    const nums = await page.$$eval('#list > .opp .score-num', (r) => r.map((x) => x.textContent));
    assert.ok(nums.some((t) => /^~\d+%$/.test(t)) && nums.some((t) => t === 'n/a'), nums.slice(0, 12).join(' '));
    await page.fill('#q', 'janitorial services contract 1');
    await page.waitForTimeout(2200); // background scoring repaints the radar meanwhile
    assert.equal(await page.inputValue('#q'), 'janitorial services contract 1', 'search text survives the repaint');
    assert.ok((await page.$$eval('#list > .opp h3', (r) => r.map((x) => x.textContent))).every((t) => /Janitorial Services Contract 1/.test(t)));
    await page.fill('#q', '');
    await page.selectOption('#sort', 'amount');
    assert.match(await text(page, '#list'), /0 of 225 listed leads state an award amount/);
    if (shots) await page.screenshot({ path: path.join(shots, '02-radar.png') });
    ok('radar pages 100 at a time, ranks AI scores first, and keeps filters through background repaints');
    await ctx.close(); assert.deepEqual(errors, []);
  }

  // 3. On-request scoring after background scoring failed.
  {
    const { page, ctx, errors, scoredIds } = await open({ failBatches: true });
    await page.click('[data-v="radar"]');
    await page.fill('#q', 'janitorial services contract 7');
    await page.click('#list > .opp h3');
    await page.waitForSelector('#scoreNow');
    assert.match(await text(page, '.score-side'), /Free estimate/);
    const before = scoredIds.length;
    await page.click('#scoreNow');
    await page.waitForFunction(() => document.querySelector('.score-side h2') && document.querySelector('.score-side h2').textContent === 'AI Fit Score');
    assert.deepEqual(scoredIds.slice(before), ['noise7']);
    assert.match(await text(page, '.score-side .score-num'), /^70%$/);
    if (shots) await page.screenshot({ path: path.join(shots, '03-score-on-request.png') });
    ok('after a failed background attempt, a lead can be scored on request (one call, that lead only)');
    await ctx.close(); assert.deepEqual(errors, []);
  }

  // 4. Alerts save with the live columns and list current matches.
  {
    const { page, ctx, errors } = await open();
    await page.click('[data-v="alerts"]');
    await page.click('#aAdd');
    await page.fill('#a_keyword', 'youth employment, VITA');
    await page.click('#aForm button[type="submit"]');
    await page.waitForSelector('#aList');
    const insert = (await page.evaluate(() => window.__calls)).find((c) => c.table === 'alert_rules' && c.op === 'insert');
    assert.deepEqual(Object.keys(insert.payload).sort(), ['active', 'keywords', 'min_score', 'name', 'org_id']);
    assert.deepEqual(insert.payload.keywords, ['youth employment', 'VITA']);
    const list = await text(page, '#aList');
    assert.match(list, /Keywords: youth employment, VITA/);
    assert.match(list, /3 current leads match/);
    assert.match(list, /Youth Employment Pathways/);
    await page.click('#aAdd');
    await page.selectOption('#a_type', 'score');
    await page.fill('#a_score', '80');
    await page.click('#aForm button[type="submit"]');
    await page.waitForSelector('#aList');
    assert.match(await text(page, '#aList'), /Fit score 80% or higher\s*1 current lead matches/);
    if (shots) await page.screenshot({ path: path.join(shots, '04-alerts.png') });
    ok('alert rules save with name/keywords/min_score and show their current matches');
    await ctx.close(); assert.deepEqual(errors, []);
  }

  // 5. Pipeline: qualified items hand requirements to Grant Factory; review items keep a short checklist.
  {
    const { page, ctx, errors } = await open();
    await page.click('[data-v="pipeline"]');
    await page.click('.pcard[data-id="p2"] .pt');
    await page.waitForSelector('#reqToFactory');
    assert.equal(await page.$('#newReq'), null);
    await page.click('#back');
    await page.click('.pcard[data-id="p1"] .pt');
    await page.waitForSelector('#newReq');
    assert.match(await text(page, '#main'), /Pre-qualification checklist/);
    ok('requirements live in Grant Factory after qualification; review stages keep a short checklist');
    await ctx.close(); assert.deepEqual(errors, []);
  }

  // 6. Guests see no purchase buttons.
  {
    const { page, ctx, errors } = await open({ guest: true, subscribed: false });
    await page.click('[data-v="profile"]');
    await page.waitForSelector('#pf');
    const card = await text(page, '#main .card');
    assert.match(card, /exploring as a guest/);
    assert.equal(await page.$$eval('a[href*="buy.stripe.com"]', (a) => a.length), 0);
    ok('guest sessions are asked to create an account before buying');
    await ctx.close(); assert.deepEqual(errors, []);
  }
  {
    const { page, ctx } = await open({ subscribed: false });
    await page.click('[data-v="profile"]');
    await page.waitForSelector('#pf');
    assert.equal(await page.$$eval('a[href*="buy.stripe.com"]', (a) => a.length), 2);
    ok('signed-in unsubscribed users still see both plans');
    assert.equal(await page.isChecked('#emailDigest'), true, 'daily email is on by default');
    await page.uncheck('#emailDigest');
    await page.waitForFunction(() => /off/.test(document.querySelector('#emailDigestMsg').textContent));
    const upd = (await page.evaluate(() => window.__calls)).find((c) => c.table === 'profiles' && c.op === 'update');
    assert.deepEqual(upd.payload, { email_digest: false });
    ok('each person can turn the daily email off on the Organization page');
    await ctx.close();
  }
  {
    const { page, ctx } = await open({ guest: true, subscribed: false });
    await page.click('[data-v="profile"]');
    await page.waitForSelector('#pf');
    assert.equal(await page.$('#emailDigest'), null, 'guests have no email to send to');
    await ctx.close();
  }

  await browser.close(); server.close();
  console.log(passed + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
