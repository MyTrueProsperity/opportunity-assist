"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../assets/alerts");
const { coreDb, BILL, MTP, INSTITUTE } = require("./helpers/core-db");

const youth = { id: "a", title: "WIOA Youth Workforce Services", summary: "Paid work experience", category: "Grant Opportunity", funding_amount: 250000 };
const janitorial = { id: "b", title: "Janitorial services for a service base", summary: "", category: "Solicitation" };

test("form input becomes a payload for the live alert_rules columns", () => {
  const k = A.ruleFromForm({ type: "keyword", keywords: " youth,  WIOA , youth ,," });
  assert.deepEqual(k.keywords, ["youth", "WIOA"]);
  assert.equal(k.min_score, null);
  assert.equal(k.active, true);
  assert.equal(k.name, "Keywords: youth, WIOA");
  assert.ok(!("type" in k) && !("keyword" in k), "never writes the columns that do not exist");
  const s = A.ruleFromForm({ type: "score", minScore: "80" });
  assert.equal(s.min_score, 80);
  assert.equal(s.keywords, null);
  assert.equal(s.name, "Fit score 80% or higher");
  assert.throws(() => A.ruleFromForm({ type: "keyword", keywords: " , " }), /at least one keyword/);
  assert.throws(() => A.ruleFromForm({ type: "score", minScore: "120" }), /0 to 100/);
});

test("keyword rules match any keyword, score rules count only real AI scores", () => {
  const kw = { keywords: ["wioa", "financial capability"] };
  assert.equal(A.matches(kw, youth, null), true);
  assert.equal(A.matches(kw, janitorial, null), false);
  const score = { min_score: 75 };
  assert.equal(A.matches(score, youth, { headline: 82 }), true);
  assert.equal(A.matches(score, youth, { headline: 90, estimate: true }), false, "a free estimate is not an AI score");
  assert.equal(A.matches(score, youth, { headline: 90, pending: true }), false);
  assert.equal(A.matches(score, youth, { headline: null, ineligible: true }), false);
  assert.equal(A.matches(score, youth, { headline_score: 77, eligibility_status: "ELIGIBLE" }), true, "server rows use headline_score");
  assert.equal(A.matches({ ...kw, active: false }, youth, null), false, "paused rules match nothing");
  assert.equal(A.matches({}, youth, null), false, "an empty rule matches nothing");
  assert.equal(A.matches({ keywords: ["youth"], min_amount: 300000 }, youth, null), false, "every condition must hold");
});

test("dashboard counts unique leads across rules", () => {
  const rules = [{ keywords: ["youth"] }, { keywords: ["wioa"] }, { min_score: 50 }];
  const hits = A.matchingOpportunities(rules, [youth, janitorial], (o) => (o.id === "b" ? { headline: 40 } : null));
  assert.deepEqual(hits.map((o) => o.id), ["a"]);
});

test("the migrated table accepts the app payload under RLS and rejects empty or out-of-range rules", async () => {
  const { pg, as } = await coreDb();
  const k = A.ruleFromForm({ type: "keyword", keywords: "youth, VITA" });
  const s = A.ruleFromForm({ type: "score", minScore: 75 });
  await as(BILL, ({ q }) => q("insert into alert_rules(org_id,name,keywords,min_score,active) values ($1,$2,$3,$4,$5)", [MTP, k.name, k.keywords, k.min_score, k.active]));
  await as(BILL, ({ q }) => q("insert into alert_rules(org_id,name,keywords,min_score,active) values ($1,$2,$3,$4,$5)", [MTP, s.name, s.keywords, s.min_score, s.active]));
  assert.equal((await as(BILL, ({ q }) => q("select count(*)::int n from alert_rules")))[0].n, 2);
  await assert.rejects(as(BILL, ({ q }) => q("insert into alert_rules(org_id,name) values ($1,'empty')", [MTP])), /alert_rules_watches_something/);
  await assert.rejects(as(BILL, ({ q }) => q("insert into alert_rules(org_id,name,min_score) values ($1,'x',101)", [MTP])), /alert_rules_min_score_range/);
  await assert.rejects(as(BILL, ({ q }) => q("insert into alert_rules(org_id,name,keywords) values ($1,'x','{youth}')", [INSTITUTE])), /row-level security/, "only the active organization");
  await pg.close();
});
