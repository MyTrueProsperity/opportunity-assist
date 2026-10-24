"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeHandler } = require("../netlify/functions/ai-assistant");
const M = require("../assets/matching");

const ENV = { SUPABASE_URL: "https://sb.test", SUPABASE_PUBLISHABLE_KEY: "pub", ANTHROPIC_API_KEY: "k", SUPABASE_SERVICE_ROLE_KEY: "svc" };
const USER = "11111111-1111-4111-8111-111111111111";
const ORG = { id: "55555555-5555-4555-8555-555555555555", name: "Institute of Bright Minds", service_areas: "Seminole County, Florida", programs: "Youth workforce" };
const OPPS = [
  { id: "good", title: "Youth workforce grant", geography: "Florida", deadline: "2026-12-01", requirements: "Nonprofits", funding_amount_label: "Up to $100,000" },
  { id: "closed", title: "Closed contract", geography: "Florida", deadline: "2026-09-17", requirements: "x" },
  { id: "passed", title: "Passed-on grant", geography: "Florida", deadline: "2026-12-01", requirements: "x" },
  { id: "inactive", title: "Inactive grant", geography: "Florida", deadline: null, requirements: "x", source_active: false },
  { id: "undated", title: "Community foundation grant", geography: null, deadline: null, requirements: null },
];

function backend() {
  const calls = { scoreQuery: null, anthropic: [], usage: [] };
  const fetcher = async (url, init = {}) => {
    const ok = (body) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.endsWith("/auth/v1/user")) return ok({ id: USER });
    if (url.startsWith("https://api.anthropic.com")) {
      calls.anthropic.push(JSON.parse(init.body));
      return ok({ content: [{ type: "text", text: "Focus on the youth workforce grant." }], usage: { input_tokens: 100, output_tokens: 20 } });
    }
    const u = new URL(url);
    const table = u.pathname.split("/").pop();
    const q = Object.fromEntries(u.searchParams);
    if (init.method === "POST" && table === "ai_usage_logs") { calls.usage.push(...JSON.parse(init.body)); return ok([]); }
    if (table === "profiles") return ok([{ org_id: ORG.id }]);
    if (table === "org_memberships") return ok([{ org_id: ORG.id }]);
    if (table === "organizations") return ok([ORG]);
    if (table === "subscriptions") return ok([{ status: "active" }]);
    if (table === "pipeline_items") return ok([{ title: "Summer jobs RFP", stage: "Writing", deadline: null, opportunities: { deadline: "2026-11-15" } }, { title: "Old win", stage: "Awarded", deadline: null, opportunities: null }]);
    if (table === "fit_scores") { calls.scoreQuery = q; return ok(OPPS.map((o, i) => ({ opportunity_id: o.id, headline_score: 90 - i, recommendation: "Strongly pursue" }))); }
    if (table === "opportunities") return ok(OPPS);
    if (table === "pursue_decisions") return ok([{ opportunity_id: "passed", decision: "pass", decided_at: "2026-10-01" }]);
    throw Error("unexpected " + url);
  };
  return { fetcher, calls };
}
const event = { httpMethod: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ message: "What should we prioritize?" }) };

test("the assistant sees current, eligible, AI-scored leads and never unscored or closed ones", async () => {
  const { fetcher, calls } = backend();
  const res = await makeHandler({ env: ENV, fetcher, today: () => "2026-10-23" })(event);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.scoreQuery.headline_score, "not.is.null", "unscored (Not eligible) rows are excluded in the query");
  assert.equal(calls.scoreQuery.order, "headline_score.desc.nullslast");
  assert.equal(calls.scoreQuery.eligibility_status, "neq.INELIGIBLE");
  assert.equal(calls.scoreQuery.source_stale, "is.false");
  assert.equal(calls.scoreQuery.rubric_version, "eq." + M.RUBRIC_VERSION);
  const system = calls.anthropic[0].system;
  assert.match(system, /Youth workforce grant/);
  assert.match(system, /Community foundation grant \(fit 86%.*no deadline listed/);
  assert.doesNotMatch(system, /Closed contract|Passed-on grant|Inactive grant/);
  assert.match(system, /TODAY: 2026-10-23/);
  assert.match(system, /Summer jobs RFP \(Writing, due 2026-11-15\)/, "open pipeline items carry their deadlines");
  assert.doesNotMatch(system, /Old win \(/, "closed pipeline stages are counted, not listed");
});

test("usage is logged before the function returns", async () => {
  const { fetcher, calls } = backend();
  await makeHandler({ env: ENV, fetcher, today: () => "2026-10-23" })(event);
  assert.equal(calls.usage.length, 1);
  assert.equal(calls.usage[0].org_id, ORG.id);
  assert.equal(calls.usage[0].input_tokens, 100);
});
