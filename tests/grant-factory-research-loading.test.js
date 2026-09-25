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

test("the browser brain carries a research summary, not records or research facts", () => {
  const out = repo.publicBrain(fixture(), owner);
  assert.equal(out.facts.some(f => f.research), false, "research facts are not shipped at startup");
  assert.equal(out.facts.find(f => f.fact_key === "mission").notes, "Org note stays.");
  assert.equal("records" in out.research, false);
  assert.deepEqual(out.research.counts, { records: 2, verified: 1, packets: 0, statistics: 0, rules: 1 });
  assert.deepEqual(out.research.packages.map(p => p.package_version), ["PKG_V1"]);
  assert.deepEqual(out.research_refs, []);
});

test("an application receives references for the research facts it cites, with the same readiness", () => {
  const brain = fixture();
  const [ready, blocked] = ["R1", "R2"].map(id => brain.facts.find(f => f.research?.record_id === id));
  const app = { id: "a", answers: [{ evidence_ids: [ready.id] }], content: { eligibility: [{ review: { evidence_ids: [blocked.id] } }] } };
  const out = repo.publicBrain(brain, owner, "a", app);
  assert.equal(out.research_refs.length, 2);
  const r1 = out.research_refs.find(r => r.id === ready.id), r2 = out.research_refs.find(r => r.id === blocked.id);
  assert.deepEqual(r1.research, { package_version: "PKG_V1", record_id: "R1" });
  assert.equal(r1.draft_ready, true);
  assert.equal(r2.draft_ready, false);
  assert.ok(r2.draft_blockers.length);
  for (const k of ["id", "display_name", "value", "source_locator", "verification_status"]) assert.ok(k in r1, k);
  assert.equal("notes" in r1, false);
  assert.equal(typeof r1.research.approved_language, "undefined", "a reference never embeds the record");
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
  for (const r of browserResearch(brain.research).records) { assert.equal('source_fields_original' in r, false); assert.equal('original_record' in r, false); }
});
