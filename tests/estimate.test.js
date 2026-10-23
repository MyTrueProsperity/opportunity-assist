"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../assets/matching");
const W = require("../assets/opportunity-workflow");

const org = { id: "org", service_areas: "Florida", keywords: ["youth employment", "financial capability", "VITA", "CTE"] };

test("the free estimate reflects keyword matches only, with no hidden floor", () => {
  const none = M.estimate(org, { title: "Janitorial services for a service base", summary: "Cleaning contract", category: "Solicitation" });
  assert.equal(none.headline, null, "no number instead of the old 60% floor");
  assert.equal(none.relevant, false);
  assert.equal(none.rec, "No keyword match");
  const body = M.estimate(org, { title: "Community grants", summary: "Supports VITA free tax sites" });
  assert.equal(body.headline, 45);
  assert.equal(body.rec, "Weak keyword match");
  const title = M.estimate(org, { title: "Youth Employment and CTE Pathways", summary: "Financial capability coaching" });
  assert.equal(title.headline, 90);
  assert.equal(title.rec, "Strong keyword match");
  assert.deepEqual(title.matched.sort(), ["cte", "financial capability", "youth employment"]);
  assert.ok(title.estimate && !M.isStrong(title), "an estimate never counts as a strong AI match");
});

test("keywords match whole words, so CTE does not match 'selected'", () => {
  assert.equal(M.estimate(org, { title: "Selected projects", summary: "respected partners" }).relevant, false);
});

test("an organization without keywords gets no number, and is not filtered", () => {
  const e = M.estimate({ keywords: [] }, { title: "Anything" });
  assert.equal(e.headline, null);
  assert.equal(e.relevant, null);
});

test("keyword matches rank ahead of unmatched estimates in Needs your decision", () => {
  const TODAY = "2026-10-23";
  const opp = (id) => ({ id, title: id, geography: "Florida", requirements: "x", deadline: "2026-12-01" });
  const opps = [opp("match"), opp("nomatch"), opp("ai")];
  const fit = { match: { estimate: true, relevant: true, headline: 45 }, nomatch: { estimate: true, relevant: false, headline: null }, ai: { headline: 70 } };
  const q = W.decisionQueue(org, opps, fit, [], {}, TODAY).map((o) => o.id);
  assert.deepEqual(q, ["ai", "match", "nomatch"]);
});
