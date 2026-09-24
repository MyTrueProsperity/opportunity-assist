"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { repository, browserFact, browserResearch } = require("../netlify/lib/grant-factory/repository");
const { researchFacts } = require("../netlify/lib/grant-factory/research");

const record = (id, verified = true) => ({
  package_version: "PKG_V1", record_id: id, topic: "Topic " + id, finding: "Finding " + id,
  approved_language: "Approved " + id, geography: "Seminole County", geography_scope: ["Florida"], evidence_domain: "Workforce",
  funding_tags: ["youth"], year: 2025, population: "Youth", source_org: "Source", source_url: "https://example.org",
  methodology: "Survey", supports: ["a"], does_not_support: ["b"], prohibited_language: ["c"], qa_flags: [],
  external_use_status: verified ? "VERIFIED" : "NEEDS_REVIEW", verification_status: verified ? "PRIMARY_VERIFIED" : "UNVERIFIED",
  last_verified: verified ? "2026-09-01" : null, review_before_external_use: !verified,
  source_fields_original: { raw: "x".repeat(2000) }, original_record: { raw: "y".repeat(1000) },
});
function fixture() {
  const bundle = { packages: [{ package_version: "PKG_V1", status: "active" }], records: [record("R1"), record("R2", false)], packets: [], rules: [{ package_version: "PKG_V1", rule_id: "CR1", title: "Rule", rule: "Keep geography." }], statistics: [], aliases: [] };
  const brain = { revision: 1, voice: "", research: bundle, programs: [], documents: [], facts: [
    { id: "11111111-1111-4111-8111-111111111111", fact_key: "mission", display_name: "Mission", value: "Education and work.", verification_status: "APPROVED", external_use_allowed: true, grant_use_allowed: true, sensitivity_level: "INTERNAL", source_reference: "Board", source_locator: "Minutes", notes: "Org note stays." },
    ...researchFacts(bundle),
  ] };
  return brain;
}
const repo = repository({ SUPABASE_URL: "https://test.invalid", SUPABASE_SERVICE_ROLE_KEY: "test", SUPABASE_PUBLISHABLE_KEY: "public" }, async () => { throw Error("Unexpected network"); });
const owner = { role: "OWNER", org_id: "o", user_id: "u" };

test("browser research facts reference their record instead of repeating it", () => {
  const brain = fixture();
  const out = repo.publicBrain(brain, owner);
  const rf = out.facts.filter(f => f.research);
  assert.equal(rf.length, 2);
  for (const f of rf) {
    assert.deepEqual(Object.keys(f.research).sort(), ["package_version", "record_id"]);
    assert.ok(out.research.records.some(r => r.package_version === f.research.package_version && r.record_id === f.research.record_id), "every reference resolves");
    assert.equal("notes" in f, false);
    // Fields the evidence picker and drafting status use are kept.
    for (const k of ["id", "display_name", "value", "source_locator", "verification_status", "draft_ready"]) assert.ok(k in f, k);
  }
  assert.equal(rf.find(f => f.research.record_id === "R1").draft_ready, true);
  assert.equal(rf.find(f => f.research.record_id === "R2").draft_ready, false);
  // Organization facts are untouched.
  assert.equal(out.facts.find(f => f.fact_key === "mission").notes, "Org note stays.");
});

test("browser research records omit provenance-only fields and keep everything displayed", () => {
  const out = repo.publicBrain(fixture(), owner);
  for (const r of out.research.records) {
    assert.equal("source_fields_original" in r, false);
    assert.equal("original_record" in r, false);
    for (const k of ["record_id", "topic", "finding", "approved_language", "geography", "geography_scope", "evidence_domain", "funding_tags", "year", "population", "source_org", "source_url", "methodology", "supports", "does_not_support", "prohibited_language", "qa_flags", "external_use_status", "verification_status", "last_verified"]) assert.ok(k in r, k);
  }
  assert.equal(out.research.rules.length, 1);
  assert.equal(out.research.packages.length, 1);
});

test("slimming the browser copy never changes the server's full research data", () => {
  const brain = fixture();
  const before = JSON.stringify(brain);
  repo.publicBrain(brain, owner);
  browserResearch(brain.research);
  brain.facts.forEach(browserFact);
  assert.equal(JSON.stringify(brain), before);
  assert.ok(brain.research.records[0].source_fields_original);
  assert.ok(brain.facts.find(f => f.research).research.approved_language);
});
