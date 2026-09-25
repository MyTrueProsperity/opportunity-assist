"use strict";
// Service-role writes from AI Fit Scoring: the shared ai_summary cache and the
// usage log. The fake backend enforces Supabase's key rule: a request that
// carries the service role key as its bearer must also send it as apikey;
// pairing it with the publishable key is rejected with 401, as in production.
// No real scoring, network or model call happens here.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeHandler } = require("../netlify/functions/score-opportunities");
const M = require("../assets/matching");

const ENV = { SUPABASE_URL: "https://sb.test", SUPABASE_PUBLISHABLE_KEY: "pub", SUPABASE_SERVICE_ROLE_KEY: "service-secret", ANTHROPIC_API_KEY: "k" };
const USER = "11111111-1111-4111-8111-111111111111";
const ORG = { id: "55555555-5555-4555-8555-555555555555", name: "Example Org", service_areas: "Florida" };
const SUMMARY = { what: "Youth jobs", who: "Nonprofits", amount: "$50,000", deadlines: "Dec 1", documents: "Budget", criteria: "Fit", deliverables: "Report", risks: "None" };

function backend() {
  const db = {
    opportunities: [
      { id: "o-1", title: "Youth workforce grant", geography: "Florida", deadline: "2026-12-01", requirements: "Nonprofits.", summary: "Youth jobs", ai_summary: null },
      { id: "o-2", title: "Adult learning grant", geography: "Florida", deadline: "2026-12-01", requirements: "Nonprofits.", summary: "Learning", ai_summary: {} },
    ],
    ai_usage_logs: [],
  };
  const calls = { anthropic: [], rejected: [], summaryWrites: 0 };
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetcher = async (url, init = {}) => {
    const h = init.headers || {};
    if (url.startsWith("https://api.anthropic.com")) {
      const req = JSON.parse(init.body);
      calls.anthropic.push(req);
      const factors = M.FACTORS.map((f) => ({ id: f.id, state: "MATCH", value: 80, required: false, reason: "r" }));
      const wantsSummary = /"ai_summary"/.test(req.system);
      return res(200, { content: [{ type: "text", text: JSON.stringify(wantsSummary ? { factors, ai_summary: SUMMARY } : { factors }) }], usage: { input_tokens: 100, output_tokens: 20 } });
    }
    const service = h.Authorization === "Bearer " + ENV.SUPABASE_SERVICE_ROLE_KEY;
    if (service && h.apikey !== ENV.SUPABASE_SERVICE_ROLE_KEY) { calls.rejected.push(url); return res(401, { message: "Invalid API key" }); }
    if (!service && h.apikey !== ENV.SUPABASE_PUBLISHABLE_KEY) return res(401, { message: "Invalid API key" });
    if (url.endsWith("/auth/v1/user")) return res(200, { id: USER });
    const u = new URL(url);
    const table = u.pathname.split("/").pop();
    const q = Object.fromEntries(u.searchParams);
    if (init.method === "PATCH" && table === "opportunities") {
      assert.ok(service, "the shared summary cache is written with the service role only");
      const row = db.opportunities.find((o) => "eq." + o.id === q.id);
      Object.assign(row, JSON.parse(init.body));
      calls.summaryWrites++;
      return res(204, null);
    }
    if (init.method === "POST" && table === "ai_usage_logs") {
      assert.ok(service, "usage is logged with the service role only");
      await new Promise((r) => setTimeout(r, 20)); // a slow write must still finish before the response
      db.ai_usage_logs.push(...JSON.parse(init.body));
      return res(201, null);
    }
    if (init.method === "POST" && table === "fit_scores") return res(201, null);
    if (table === "profiles") return res(200, [{ org_id: ORG.id }]);
    if (table === "org_memberships") return res(200, [{ org_id: ORG.id }]);
    if (table === "organizations") return res(200, [ORG]);
    if (table === "subscriptions") return res(200, [{ status: "active" }]);
    if (table === "opportunities") return res(200, db.opportunities.map((o) => ({ ...o })));
    throw Error("unexpected " + url);
  };
  return { db, calls, fetcher };
}

const event = { httpMethod: "POST", headers: { authorization: "Bearer user-token" }, body: JSON.stringify({ opportunity_ids: ["o-1", "o-2"] }) };
const run = (b) => makeHandler({ env: ENV, fetcher: b.fetcher, today: () => "2026-09-25" })(event);

test("generated summaries are saved to the shared cache with the service role key", async () => {
  const b = backend();
  const out = await run(b);
  assert.equal(out.statusCode, 200);
  assert.deepEqual(b.calls.rejected, [], "no service-role write is rejected");
  assert.equal(b.calls.summaryWrites, 2);
  assert.deepEqual(b.db.opportunities.map((o) => o.ai_summary), [SUMMARY, SUMMARY]);
  assert.ok(JSON.parse(out.body).results.every((r) => r.ai_summary && r.ai_summary.what === "Youth jobs"));
});

test("usage logging succeeds and completes before the response", async () => {
  const b = backend();
  await run(b);
  assert.equal(b.db.ai_usage_logs.length, 1);
  assert.deepEqual(b.db.ai_usage_logs[0], { org_id: ORG.id, model: "claude-haiku-4-5-20251001", opportunity_count: 2, input_tokens: 200, output_tokens: 40 });
});

test("a second run reuses cached summaries and does not regenerate them", async () => {
  const b = backend();
  await run(b);
  const firstPrompts = b.calls.anthropic.length;
  assert.ok(b.calls.anthropic.every((r) => /"ai_summary"/.test(r.system)), "first run asks for summaries");
  await run(b);
  const second = b.calls.anthropic.slice(firstPrompts);
  assert.equal(second.length, 2, "scoring still runs");
  assert.ok(second.every((r) => !/"ai_summary"/.test(r.system) && r.max_tokens === 1100), "no summary is requested again");
  assert.equal(b.calls.summaryWrites, 2, "no second cache write");
  assert.equal(b.db.ai_usage_logs.length, 2, "each run is logged");
});

test("user-scoped reads and writes still use the publishable key with the session token", async () => {
  const b = backend();
  const seen = [];
  const inner = b.fetcher;
  b.fetcher = async (url, init = {}) => { if (!url.startsWith("https://api.anthropic.com")) seen.push([new URL(url).pathname.split("/").pop(), init.headers.apikey, init.headers.Authorization]); return inner(url, init); };
  await run(b);
  for (const [table, apikey, auth] of seen) {
    if (auth === "Bearer user-token") assert.equal(apikey, "pub", table);
    else assert.ok(["opportunities", "ai_usage_logs"].includes(table) && apikey === "service-secret", table);
  }
  assert.ok(seen.some(([t, , a]) => t === "fit_scores" && a === "Bearer user-token"), "fit scores are written as the user (RLS applies)");
});

test("without a service role key nothing is written with elevated rights", async () => {
  const b = backend();
  const out = await makeHandler({ env: { ...ENV, SUPABASE_SERVICE_ROLE_KEY: "" }, fetcher: b.fetcher, today: () => "2026-09-25" })(event);
  assert.equal(out.statusCode, 200);
  assert.equal(b.calls.summaryWrites, 0);
  assert.equal(b.db.ai_usage_logs.length, 0);
  assert.equal(JSON.parse(out.body).service_role_configured, false);
});
