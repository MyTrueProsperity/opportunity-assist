"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { service } = require("../netlify/lib/grant-factory/service");
const { METHODOLOGY, strategyFramework } = require("../netlify/lib/grant-factory/methodology");
const { createTestRepo, ORG } = require("./helpers/grant-db");
const { testPack } = require("./helpers/grant-seed");

test("methodology rules are complete, organization-neutral and versioned", () => {
  assert.ok(METHODOLOGY.version.startsWith("GRANT_METHODOLOGY_V1"));
  assert.equal(new Set(METHODOLOGY.rules.map(r => r.id)).size, METHODOLOGY.rules.length);
  const text = JSON.stringify(METHODOLOGY.rules);
  for (const phrase of ["Evidence chain", "Causality alignment", "Localization rule", "Organizational language safeguard", "Statistical translation", "Budget and narrative consistency", "Geographic evidence tiers", "Source confidence", "Status claims need their own proof", "Measure definitions"])
    assert.ok(text.includes(phrase), phrase);
  // The repository is public: no institution names in the shared rules.
  assert.doesNotMatch(text, /Bright Minds|Junction|John Doe|Seminole/i);
  assert.doesNotMatch(text, /\u2014/, "no em dashes");
  // Status claims: adoption, ratings, commitments and awards each need their own proof.
  const gm17 = METHODOLOGY.rules.find(r => r.id === "GM-17").rule;
  for (const phrase of ["not adopting", "not a rating", "not a commitment", "not an award", "not the applicant's probability of award"])
    assert.ok(gm17.includes(phrase), phrase);
});

test("strategy framework includes only the selected programs and is marked as not evidence", () => {
  const fw = { program_alignment: [{ program_id: "a", name: "A" }, { program_id: "b", name: "B" }], logic_model: { inputs: ["x"] }, quarantine: [{ id: "Q-1", claim: "38%" }] };
  const out = strategyFramework(fw, ["a", null]);
  assert.equal(out.status, "PLANNING_FRAMEWORK_NOT_EVIDENCE");
  assert.deepEqual(out.program_alignment.map(p => p.name), ["A"]);
  assert.deepEqual(out.logic_model, { inputs: ["x"] });
  assert.equal("quarantine" in out, false, "quarantined claims never reach the AI");
  assert.equal(strategyFramework(null, ["a"]), null);
});

test("methodology reaches strategy, writer and auditor; the framework reaches strategy only", async () => {
  const f = await createTestRepo();
  try {
    const seen = {};
    let brain;
    const ai = { enabled: true, async call(task, data) {
      seen[task] = data;
      const mission = brain.facts.find(x => x.fact_key === "mission");
      if (task === "strategy") return { data: { primary_case: "Case", funder_priorities: "", alignment_points: "", themes_to_emphasize: "", themes_to_deemphasize: "", likely_funding_use: "", evidence_gaps: "", evidence_chain: "Need to impact", budget_consistency: "None found" } };
      if (task === "write") return { data: { status: "DRAFTED", answer: mission.value, evidence_ids: [mission.id], missing_information: [], warnings: [] } };
      if (task === "audit") return { data: { coverage_complete: true, claims: [{ claim: data.answer, status: "SUPPORTED", reason: "ok", evidence_ids: [mission.id] }] } };
      throw Error("Unexpected task " + task);
    } };
    // Strategy runs as a background job; run it inline here.
    const s = service(f.repo, ai, { dispatch: (ctx, job) => s.runStrategyJob(ctx, job.id) });
    await s.handle(f.owner, { action: "seed", pack: testPack() });
    brain = await f.repo.brain(f.owner);
    const [primary, other] = brain.programs;
    await f.pg.query("update gf_workspaces set framework=$1 where org_id=$2", [JSON.stringify({
      program_alignment: [{ program_id: primary.id, name: primary.name, funding_alignment: ["education"] }, { program_id: other.id, name: other.name, funding_alignment: ["arts"] }],
      logic_model: { inputs: ["facilities"], caution: "Planned, not achieved." },
      quarantine: [{ id: "Q-01", claim: "Unverified 38% statistic", status: "QUARANTINED" }],
    }), ORG]);
    const boot = await s.handle(f.owner, { action: "bootstrap" });
    assert.equal(boot.methodology.version, METHODOLOGY.version);
    assert.equal(boot.brain.framework.quarantine.length, 1, "shown read-only in the Research Library");
    let app = await s.handle(f.owner, { action: "new_application", funder_name: "Test Foundation", grant_program_name: "Education grant", text: "1. Describe your mission. Maximum 100 words." });
    const qId = app.questions[0].id;
    app = await s.handle(f.owner, { action: "save_application", application_id: app.id, revision: app.revision, application: { primary_program_id: primary.id } });
    const started = await s.handle(f.owner, { action: "strategy", application_id: app.id, revision: app.revision });
    assert.equal(started.job.status, "COMPLETED");
    app = (await s.handle(f.owner, { action: "get_application", application_id: app.id })).app;
    assert.deepEqual(seen.strategy.methodology_rules, METHODOLOGY.rules);
    assert.deepEqual(seen.strategy.organization_framework.program_alignment.map(p => p.name), [primary.name]);
    assert.equal(JSON.stringify(seen.strategy).includes("Unverified 38%"), false);
    assert.equal(app.content.strategy.evidence_chain, "Need to impact");
    assert.equal(app.content.strategy.budget_consistency, "None found");
    app = await s.handle(f.owner, { action: "save_application", application_id: app.id, revision: app.revision, application: { strategy: { ...app.content.strategy }, strategy_approved: true } });
    app = await s.handle(f.owner, { action: "confirm_parser", application_id: app.id, revision: app.revision });
    app = await s.handle(f.owner, { action: "draft", application_id: app.id, revision: app.revision, question_id: qId });
    assert.deepEqual(seen.write.methodology_rules, METHODOLOGY.rules);
    assert.equal("organization_framework" in seen.write, false, "the framework is never evidence for the writer");
    assert.equal(JSON.stringify(seen.write).includes("Unverified 38%"), false);
    app = await s.handle(f.owner, { action: "audit_answer", application_id: app.id, revision: app.revision, question_id: qId });
    assert.deepEqual(seen.audit.methodology_rules, METHODOLOGY.rules);
    assert.equal(JSON.stringify(seen.audit).includes("Unverified 38%"), false);
  } finally { await f.pg.close(); }
});
