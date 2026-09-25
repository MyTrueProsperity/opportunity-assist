"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../assets/matching");
const { coreDb, MTP, INSTITUTE } = require("./helpers/core-db");

const INSTITUTE_PROFILE = { service_areas: "Seminole County, Orange County, Central Florida, Florida" };
const TODAY = "2026-09-25";
// Fixtures modeled on the six June sample opportunities removed from production.
const FIXTURES = {
  wioa: { title: "WIOA Youth Workforce Services", geography: "Florida", deadline: "2026-10-16", requirements: "Serve WIOA-eligible youth.", category: "Youth Workforce" },
  expired: { title: "CTE Work-Based Learning RFP", geography: "Florida", deadline: "2026-08-09", requirements: "Employer partnerships.", category: "Education / CTE" },
  national: { title: "Employability Services", geography: "National", deadline: "2026-12-01", requirements: "Experience required.", category: "Employability" },
  regional: { title: "CRA-Aligned Community Prosperity Fund", geography: "Southeast US", deadline: null, requirements: "", category: "CRA / Community" },
  otherState: { title: "Total Force eLearning", geography: "Virginia", deadline: "2026-11-01", requirements: "Contract.", category: "Sources Sought" },
  inactive: { title: "Old program", geography: "Florida", deadline: "2026-12-01", requirements: "x", source_active: false },
  foundation: { title: "Palm Beach Community Trust Fund", geography: null, deadline: null, requirements: null, category: "Foundation Grant" },
  singleSource: { title: "Single Source Competition for Continuation of Research", geography: "National", deadline: null, requirements: "x" },
};

test("statesIn reads state names and postal codes without Virginia/West Virginia or DC/Washington confusion", () => {
  assert.deepEqual(M.statesIn("Seminole County, Orange County, Central Florida, Florida"), ["FL"]);
  assert.deepEqual(M.statesIn("Sanford, FL"), ["FL"]);
  assert.deepEqual(M.statesIn("West Virginia"), ["WV"]);
  assert.deepEqual(M.statesIn("Virginia and West Virginia"), ["VA", "WV"]);
  assert.deepEqual(M.statesIn("Washington, DC"), ["DC"]);
  assert.deepEqual(M.statesIn("Washington"), ["WA"]);
  assert.deepEqual(M.statesIn("Southeast US"), []);
});

test("eligibility rejects only on known facts and keeps unknowns as unknown", () => {
  const e = (k) => M.eligibility(INSTITUTE_PROFILE, FIXTURES[k], TODAY);
  assert.equal(e("wioa").status, "ELIGIBLE");
  assert.equal(e("national").status, "ELIGIBLE");
  assert.equal(e("expired").status, "INELIGIBLE");
  assert.match(e("expired").reasons[0], /deadline \(2026-08-09\) has passed/);
  assert.equal(e("otherState").status, "INELIGIBLE");
  assert.match(e("otherState").reasons[0], /Limited to Virginia/);
  assert.equal(e("inactive").status, "INELIGIBLE");
  assert.equal(e("singleSource").status, "INELIGIBLE");
  // Missing deadline, geography or requirements is UNKNOWN, never a failure.
  assert.equal(e("foundation").status, "UNKNOWN");
  assert.deepEqual(e("foundation").unknowns, ["deadline", "geography", "requirements"]);
  assert.equal(e("regional").status, "UNKNOWN", "a region with no named state is not treated as out of area");
  // A rolling/undated opportunity is not expired.
  assert.equal(M.eligibility(INSTITUTE_PROFILE, { ...FIXTURES.wioa, deadline: null }, TODAY).status, "UNKNOWN");
  // An organization with no stated service area cannot be excluded on geography.
  assert.equal(M.eligibility({}, FIXTURES.otherState, TODAY).status, "UNKNOWN");
});

const all = (state, value, extra = {}) => M.FACTORS.map((f) => ({ id: f.id, state, value, ...extra }));

test("headline is calculated from weighted factors, not supplied by the model", () => {
  const r = M.computeHeadline(all("MATCH", 90));
  assert.equal(r.headline, 90);
  assert.equal(r.confidence, 1);
  assert.equal(r.recommendation, "Strongly pursue");
  assert.equal(r.factors.length, 10);
  const weights = M.FACTORS.reduce((s, f) => s + f.weight, 0);
  assert.ok(Math.abs(weights - 1) < 1e-9, "weights sum to 1");
});

test("unknown factors are excluded rather than scored as zero", () => {
  const ratings = all("MATCH", 90).map((r) => (["funding_fit", "timing", "evidence_fit", "risk"].includes(r.id) ? { id: r.id, state: "UNKNOWN", value: null } : r));
  const r = M.computeHeadline(ratings);
  assert.equal(r.headline, 90, "missing award amount, deadline, past performance and risk do not lower the score");
  assert.equal(r.confidence, 0.74);
  assert.equal(r.factors.find((f) => f.id === "timing").val, null);
});

test("a required but unknown item caps the score below strong; known mismatches cap hard", () => {
  const required = all("MATCH", 95).map((r) => (r.id === "eligibility" ? { id: r.id, state: "UNKNOWN", value: null, required: true } : r));
  const a = M.computeHeadline(required);
  assert.equal(a.headline, 74);
  assert.notEqual(a.recommendation, "Strongly pursue");
  const mismatch = all("MATCH", 95).map((r) => (r.id === "geography" ? { id: r.id, state: "MISMATCH", value: 10 } : r));
  assert.equal(M.computeHeadline(mismatch).headline, 25);
});

test("values are kept consistent with the stated judgment and low confidence is flagged", () => {
  const r = M.computeHeadline([{ id: "organizational_fit", state: "MISMATCH", value: 95 }, { id: "programmatic_fit", state: "MATCH", value: 10 }]);
  assert.equal(r.factors[0].val, 40);
  assert.equal(r.factors[1].val, 60);
  assert.equal(r.confidence, 0.3);
  assert.equal(r.recommendation, "Needs more information");
  assert.equal(M.computeHeadline([]).headline, null);
});

test("isStrong counts only current-rubric AI scores that are eligible and confident", () => {
  const base = { headline: 80, confidence: 0.8, rubric_version: M.RUBRIC_VERSION };
  assert.equal(M.isStrong(base), true);
  assert.equal(M.isStrong({ ...base, estimate: true }), false);
  assert.equal(M.isStrong({ ...base, ineligible: true }), false);
  assert.equal(M.isStrong({ ...base, rubric_version: "old" }), false);
  assert.equal(M.isStrong({ ...base, confidence: 0.4 }), false);
});

test("scores go stale when the organization profile or opportunity inputs change", async () => {
  const { pg } = await coreDb();
  const [o1] = (await pg.query("insert into opportunities(title,deadline) values('A','2026-12-01') returning id")).rows;
  const [o2] = (await pg.query("insert into opportunities(title) values('B') returning id")).rows;
  for (const org of [MTP, INSTITUTE]) for (const o of [o1, o2]) await pg.query("insert into fit_scores(org_id,opportunity_id,headline_score) values($1,$2,50)", [org, o.id]);
  const stale = async () => (await pg.query("select org_id, opportunity_id from fit_scores where source_stale order by org_id, opportunity_id")).rows.length;
  await pg.query("update organizations set name=name where id=$1", [MTP]);
  assert.equal(await stale(), 0, "an update that changes nothing scored does not mark stale");
  await pg.query("update organizations set target_populations='youth' where id=$1", [MTP]);
  assert.equal(await stale(), 2, "a profile change marks only that organization's scores stale");
  await pg.query("update opportunities set deadline='2027-01-15' where id=$1", [o2.id]);
  assert.equal(await stale(), 3, "a deadline change marks that opportunity stale for every organization");
  await pg.query("update opportunities set ai_summary='{}' where id=$1", [o1.id]);
  assert.equal(await stale(), 3, "cached summaries do not invalidate scores");
});
