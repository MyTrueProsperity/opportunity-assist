"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeHandler } = require("../netlify/functions/score-opportunities");
const M = require("../assets/matching");

const ENV = { SUPABASE_URL: "https://sb.test", SUPABASE_PUBLISHABLE_KEY: "pub", ANTHROPIC_API_KEY: "k" };
const USER = "11111111-1111-4111-8111-111111111111";
const MTP = { id: "44444444-4444-4444-8444-444444444444", name: "My True Prosperity, LLC", service_areas: "Florida" };
const INST = { id: "55555555-5555-4555-8555-555555555555", name: "Institute of Bright Minds", service_areas: "Seminole County, Florida", target_populations: "Youth ages 13-24" };
const OPPS = [
  { id: "o-open", title: "Youth workforce grant", geography: "Florida", deadline: "2026-12-01", requirements: "Nonprofits.", summary: "Youth jobs", ai_summary: { what: "x" } },
  { id: "o-expired", title: "Old grant", geography: "Florida", deadline: "2026-01-01", requirements: "x" },
  { id: "o-ohio", title: "Ohio grant", geography: "Ohio", deadline: "2026-12-01", requirements: "x" },
];

function fakeBackend({ activeOrg, memberships, sub = "active" }) {
  const calls = { upserts: [], anthropic: [], orgQueried: [] };
  const fetcher = async (url, init = {}) => {
    const ok = (body) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.endsWith("/auth/v1/user")) return ok({ id: USER });
    if (url.startsWith("https://api.anthropic.com")) {
      calls.anthropic.push(JSON.parse(init.body));
      const factors = M.FACTORS.map((f) => ({ id: f.id, state: f.id === "funding_fit" ? "UNKNOWN" : "MATCH", value: f.id === "funding_fit" ? null : 88, required: false, reason: "r" }));
      return ok({ content: [{ type: "text", text: JSON.stringify({ factors, headline_score: 3 }) }], usage: { input_tokens: 10, output_tokens: 5 } });
    }
    const u = new URL(url);
    const table = u.pathname.split("/").pop();
    const q = Object.fromEntries(u.searchParams);
    if (init.method === "POST" && table === "fit_scores") { calls.upserts.push(...JSON.parse(init.body)); return ok([]); }
    if (table === "profiles") return ok([{ org_id: activeOrg.id }]);
    if (table === "org_memberships") return ok(memberships.includes(q.org_id.replace("eq.", "")) ? [{ org_id: activeOrg.id }] : []);
    if (table === "organizations") { calls.orgQueried.push(q.id); return ok([activeOrg]); }
    if (table === "subscriptions") return ok([{ status: sub }]);
    if (table === "opportunities") return ok(OPPS);
    throw Error("unexpected " + url);
  };
  return { fetcher, calls };
}
const event = { httpMethod: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ opportunity_ids: OPPS.map((o) => o.id) }) };

test("scoring uses the active organization and records scores under it", async () => {
  const { fetcher, calls } = fakeBackend({ activeOrg: INST, memberships: [INST.id, MTP.id] });
  const res = await makeHandler({ env: ENV, fetcher, today: () => "2026-09-25" })(event);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.org_id, INST.id);
  assert.deepEqual(calls.orgQueried, ["eq." + INST.id]);
  assert.ok(calls.upserts.every((r) => r.org_id === INST.id));
  assert.match(calls.anthropic[0].messages[0].content, /Institute of Bright Minds/);
});

test("known-ineligible opportunities are recorded without an AI call; the headline is computed in code", async () => {
  const { fetcher, calls } = fakeBackend({ activeOrg: INST, memberships: [INST.id] });
  const body = JSON.parse((await makeHandler({ env: ENV, fetcher, today: () => "2026-09-25" })(event)).body);
  assert.equal(calls.anthropic.length, 1, "only the open, in-state opportunity reaches the model");
  const byId = Object.fromEntries(body.results.map((r) => [r.opportunity_id, r]));
  assert.equal(byId["o-expired"].eligibility_status, "INELIGIBLE");
  assert.equal(byId["o-expired"].headline_score, null);
  assert.equal(byId["o-ohio"].eligibility_status, "INELIGIBLE");
  assert.equal(byId["o-open"].headline_score, 88, "the model's own headline_score (3) is ignored");
  assert.equal(byId["o-open"].confidence, 0.92);
  assert.equal(byId["o-open"].rubric_version, M.RUBRIC_VERSION);
  const saved = calls.upserts.find((r) => r.opportunity_id === "o-open");
  assert.equal(saved.source_stale, false);
  assert.equal(saved.factors.find((f) => f.id === "funding_fit").state, "UNKNOWN");
});

test("an active organization without a membership row is refused", async () => {
  const { fetcher, calls } = fakeBackend({ activeOrg: INST, memberships: [MTP.id] });
  const res = await makeHandler({ env: ENV, fetcher })(event);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.anthropic.length, 0);
  assert.equal(calls.upserts.length, 0);
});

test("the paywall still applies to the active organization", async () => {
  const { fetcher, calls } = fakeBackend({ activeOrg: MTP, memberships: [MTP.id], sub: "inactive" });
  const res = await makeHandler({ env: ENV, fetcher })(event);
  assert.equal(res.statusCode, 402);
  assert.equal(calls.anthropic.length, 0);
});
