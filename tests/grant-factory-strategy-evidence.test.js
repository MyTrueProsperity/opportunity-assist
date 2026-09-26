"use strict";
// Strategy evidence at production volume: bounded, relevant, eligible, and
// within the model's request budget. Uses the real repository and research
// RPCs over ~750 synthetic records (no private research).
const test = require("node:test");
const assert = require("node:assert/strict");
const { researchVolume, insertPackage, insertSupporting } = require("./helpers/research-volume");
const { service } = require("../netlify/lib/grant-factory/service");
const C = require("../netlify/lib/grant-factory/core");
const SE = require("../netlify/lib/grant-factory/strategy-evidence");
const AI = require("../netlify/lib/grant-factory/ai");

const STRATEGY = { primary_case: "Case", funder_priorities: "Priorities", alignment_points: "Points", themes_to_emphasize: "", themes_to_deemphasize: "", likely_funding_use: "", evidence_gaps: "Gaps", evidence_chain: "Need to impact", budget_consistency: "No unfunded activities found" };
const tokens = (task, data) => SE.estimateTokens(AI.requestChars(task, data));

let f, s, seen, reply, program, app;
test.before(async () => {
  f = await researchVolume();
  f.real.storage = f.repo.storage; // in-memory object storage; no network
  seen = {};
  reply = {};
  const ai = { enabled: true, async call(task, data) {
    seen[task] = data;
    if (reply[task]) return { data: reply[task](data) };
    if (task === "strategy") return { data: STRATEGY };
    throw Error("Unexpected task " + task);
  } };
  // Strategy runs as a background job; run it inline here.
  s = service(f.real, ai, { dispatch: (ctx, job) => s.runStrategyJob(ctx, job.id) });
  await addProgram(f.ORG);
  const brain = await f.real.brain(f.ctx);
  program = brain.programs[0];
  // Distinctive, relevant records: three verified, one review-gated, and one
  // in a package assigned only to another organization.
  const mark = async (pkg, id, extra = {}) => f.pg.query(
    "update research_evidence.evidence_records set payload = payload || $3::jsonb, topic=$4 where package_version=$1 and record_id=$2",
    [pkg, id, JSON.stringify({ topic: "Aquaponics apprenticeship outcomes", funding_tags: ["AQUAPONICS", "APPRENTICESHIP"], ...extra }), "Aquaponics apprenticeship outcomes"]);
  await mark("VOLUME_A", "CFSC-001"); // i=1: verified
  await mark("VOLUME_B", "GW-002");   // verified
  await mark("VOLUME_C", "AM-003");   // verified
  await mark("VOLUME_A", "CFSC-015"); // i=15: review-gated (CONVERSATION_ONLY)
  await mark("VOLUME_OTHER", "EP-001");
  await mark("VOLUME_STAGING", "NC-001");
  app = await s.handle(f.ctx, { action: "new_application", funder_name: "Aquaponics Apprenticeship Fund", grant_program_name: "Aquaponics apprenticeship grant", text: "1. Describe the need for aquaponics apprenticeship training in your region." });
  app = await s.handle(f.ctx, { action: "save_application", application_id: app.id, revision: app.revision, application: { primary_program_id: program.id, funding_purpose: "Aquaponics apprenticeships for youth" } });
});
test.after(async () => { await f.pg.close(); });

async function addProgram(org) {
  await f.pg.query("insert into gf_programs(id,org_id,content) values(gen_random_uuid(),$1,$2)", [org, JSON.stringify({
    name: "Youth Apprenticeship Program", public_name: "Youth Apprenticeship Program", status: "ACTIVE", tags: ["apprenticeship", "youth"],
    description: "Paid apprenticeships for youth.", target_population_summary: "Youth ages 16-24", verification_status: "APPROVED",
    external_use_allowed: true, grant_use_allowed: true, source_reference: "Board", source_locator: "Plan p.1" })]);
}
// Queue strategy (the job runs inline), then return the saved application.
// A failed job is raised as an error carrying its failure code.
async function runStrategy(ctx = f.ctx, a = app, svc = s) {
  const fresh = await svc.handle(ctx, { action: "get_application", application_id: a.id });
  const out = await svc.handle(ctx, { action: "strategy", application_id: a.id, revision: fresh.app.revision });
  if (out.job.status === "FAILED") throw Object.assign(Error(out.job.error), { code: out.job.failure_code });
  return (await svc.handle(ctx, { action: "get_application", application_id: a.id })).app;
}
const research = (req) => req.facts.filter((x) => x.research);

test("strategy receives a bounded selection, not the verified corpus", async () => {
  const brain = await f.real.brain(f.ctx);
  const verified = C.authorizedFacts(brain, app.id).filter((x) => x.research).length;
  assert.ok(verified > 400, "fixture has production-scale verified research: " + verified);
  const out = await runStrategy();
  const got = research(seen.strategy);
  assert.ok(got.length > 0 && got.length <= SE.STRATEGY_RESEARCH_MAX, "selected " + got.length);
  assert.ok(got.length < verified);
  assert.equal(out.content.strategy_evidence.research_selected, got.length);
  assert.equal(out.content.strategy_evidence.research_eligible, verified);
  assert.ok(tokens("strategy", seen.strategy) <= SE.EVIDENCE_REQUEST_TOKEN_BUDGET);
  // Organization facts are unchanged: every authorized org fact is still sent.
  const orgAuthorized = C.authorizedFacts(brain, app.id).filter((x) => !x.research && (!x.program_id || x.program_id === program.id)).map((x) => x.id).sort();
  assert.deepEqual(seen.strategy.facts.filter((x) => !x.research).map((x) => x.id).sort(), orgAuthorized);
  for (const x of seen.strategy.facts) for (const k of SE.BOOKKEEPING) assert.equal(k in x, false, k);
  assert.ok(tokens("strategy", seen.strategy) <= SE.STRATEGY_TOKEN_BUDGET);
});

test("relevant records rank first; review-gated, other-org and staging records never appear", async () => {
  await runStrategy();
  const got = research(seen.strategy).map((x) => x.research.package_version + "/" + x.research.record_id);
  assert.deepEqual(got.slice(0, 3).sort(), ["VOLUME_A/CFSC-001", "VOLUME_B/GW-002", "VOLUME_C/AM-003"]);
  const text = JSON.stringify(seen.strategy);
  for (const banned of ["CFSC-015", "EP-001", "NC-001", "VOLUME_OTHER", "VOLUME_STAGING"]) assert.equal(text.includes(banned), false, banned);
  for (const x of research(seen.strategy)) {
    assert.equal(x.verification_status, "VERIFIED");
    assert.equal(x.research.external_use_status, "VERIFIED");
  }
  const top = research(seen.strategy)[0];
  assert.match(top.selection.reasons.join(" "), /aquaponic/);
  assert.equal(top.selection.rank, 1);
});

test("selected records keep limits, prohibited wording and provenance citations; raw import copies are dropped", async () => {
  await runStrategy();
  for (const x of research(seen.strategy)) {
    const r = x.research;
    assert.ok(r.does_not_support?.length && r.prohibited_language?.length && r.approved_language && r.finding);
    assert.ok(r.source_url && r.source_org && r.methodology);
    assert.equal("source_fields_original" in r, false);
    assert.equal("original_record" in r, false);
  }
  // Claim rules cover every selected package and nothing else.
  const pkgs = new Set(research(seen.strategy).map((x) => x.research.package_version));
  assert.ok(seen.strategy.claim_rules.length > 0);
  assert.ok(seen.strategy.claim_rules.every((r) => pkgs.has(r.package_version)));
  for (const p of pkgs) assert.ok(seen.strategy.claim_rules.some((r) => r.package_version === p));
});

test("claim rules scoped to specific records follow the selection", () => {
  const brain = { research: { aliases: [{ package_version: "P", legacy_record_id: "OLD-1", canonical_record_id: "R-1" }], rules: [
    { package_version: "P", rule_id: "all" },
    { package_version: "P", rule_id: "r1", record_ids: ["R-1"] },
    { package_version: "P", rule_id: "legacy", record_ids: ["OLD-1"] },
    { package_version: "P", rule_id: "r2", record_ids: ["R-2"] },
    { package_version: "Q", rule_id: "other" },
  ] } };
  const facts = [{ research: { package_version: "P", record_id: "R-1" } }, { id: "org" }];
  assert.deepEqual(SE.strategyRules(brain, facts).map((r) => r.rule_id), ["all", "r1", "legacy"]);
});

test("the crosswalk ranks records but stays planning material, not evidence", async () => {
  // Link an unremarkable verified record to the selected program.
  await f.pg.query("update gf_workspaces set framework=$1 where org_id=$2", [JSON.stringify({
    program_alignment: [{ program_id: program.id, name: program.name }],
    evidence_crosswalk: { status: "PLANNING_CROSSWALK_NOT_EVIDENCE", entries: [{ component: "Hands-on work", program_ids: [program.id], records: ["GW-100", "CFSC-015"], proposition: "Planning proposition", do_not_claim: "Do not claim X" }] },
    quarantine: [{ id: "Q-1", claim: "QUARANTINED-CLAIM", status: "QUARANTINED" }],
  }), f.ORG]);
  try {
    await runStrategy();
    const text = JSON.stringify(seen.strategy);
    assert.equal(text.includes("QUARANTINED-CLAIM"), false, "quarantine never reaches AI");
    assert.equal("evidence_crosswalk" in (seen.strategy.organization_framework || {}), false, "crosswalk is not sent as evidence");
    assert.equal(text.includes("Planning proposition"), false);
    assert.equal(text.includes("CFSC-015"), false, "a crosswalk link does not make review-gated research usable");
    const linked = research(seen.strategy).find((x) => x.research.record_id === "GW-100");
    assert.ok(linked, "crosswalk-linked verified record is ranked into the selection");
    assert.match(linked.selection.reasons.join(" "), /planning aid, not evidence/);
  } finally {
    await f.pg.query("update gf_workspaces set framework=null where org_id=$1", [f.ORG]);
  }
});

test("evidence_chain and budget_consistency are saved; fabricated research ids are rejected", async () => {
  reply.strategy = (data) => ({ ...STRATEGY, evidence_chain: "Need: " + research(data)[0].research.record_id + " supports local need.", budget_consistency: "Mentoring stipends lack a funding source." });
  let out = await runStrategy();
  assert.match(out.content.strategy.evidence_chain, /Need: (CFSC-001|GW-002|AM-003) supports local need\./);
  assert.equal(out.content.strategy.budget_consistency, "Mentoring stipends lack a funding source.");
  assert.equal(out.content.strategy.approved, false);
  assert.ok(out.content.strategy_evidence.records.every((r) => r.fact_id && r.record_id && r.package_version && r.reasons.length));
  // A record that exists in the library but was not supplied.
  reply.strategy = () => ({ ...STRATEGY, evidence_chain: "Need: GW-250 proves everything." });
  await assert.rejects(runStrategy(), (e) => e.code === "EVIDENCE_CHAIN" && /GW-250/.test(e.message));
  const after = await s.handle(f.ctx, { action: "get_application", application_id: app.id });
  assert.match(after.app.content.strategy.evidence_chain, /supports local need/, "the failed run saved nothing");
  delete reply.strategy;
});

test("a much larger library does not make the strategy request grow", async () => {
  await runStrategy();
  const before = { chars: SE.size(seen.strategy), n: research(seen.strategy).length };
  const ids = await insertPackage(f.pg, "VOLUME_D", "EM", 400, { start: 1 });
  await insertSupporting(f.pg, "VOLUME_D", ids);
  try {
    const brain = await f.real.brain(f.ctx);
    const verified = C.authorizedFacts(brain, app.id).filter((x) => x.research);
    // The old design sent every verified record.
    const oldChars = SE.size(verified);
    await runStrategy();
    const after = { chars: SE.size(seen.strategy), n: research(seen.strategy).length };
    assert.ok(after.n <= SE.STRATEGY_RESEARCH_MAX);
    assert.ok(tokens("strategy", seen.strategy) <= SE.EVIDENCE_REQUEST_TOKEN_BUDGET);
    assert.ok(after.chars < before.chars * 1.5, `request grew from ${before.chars} to ${after.chars}`);
    assert.ok(oldChars > 3 * after.chars, `old design would send ${oldChars} chars of research alone`);
  } finally {
    await f.pg.query("delete from research_evidence.packages where package_version='VOLUME_D'");
  }
});

test("the request budget prunes lower-ranked records and keeps the strongest whole", async () => {
  const brain = await f.real.brain(f.ctx);
  const current = (await s.handle(f.ctx, { action: "get_application", application_id: app.id })).app;
  const facts = C.authorizedFacts(brain, app.id);
  const rest = { application: {}, questions: current.questions };
  const full = SE.strategyRequest(brain, current, facts, rest, SE.strategyRules);
  const orgOnly = SE.size({ ...rest, facts: facts.filter((x) => !x.research), claim_rules: [] });
  // A budget with room for only a handful of records.
  const tight = SE.strategyRequest(brain, current, facts, rest, SE.strategyRules, { tokenBudget: Math.ceil((orgOnly + 60000) / SE.CHARS_PER_TOKEN) });
  assert.ok(tight.selected.length > 0 && tight.selected.length < full.selected.length);
  assert.ok(tight.chars <= (orgOnly + 60000));
  assert.deepEqual(tight.selected.map((x) => x.id), full.selected.slice(0, tight.selected.length).map((x) => x.id), "pruning keeps the strongest records, in rank order");
  assert.ok(tight.skipped_for_size > 0);
  for (const x of tight.selected) assert.ok(x.research.does_not_support.length && x.research.prohibited_language.length, "records are never truncated");
  // If organization facts alone exceed the budget, nothing is sent.
  const none = SE.strategyRequest(brain, current, facts, rest, SE.strategyRules, { tokenBudget: 10 });
  assert.equal(none.overBudget, true);
});

test("organization isolation: another org's strategy never sees this org's research", async () => {
  const s2 = service(f.real, { enabled: true, async call(task, data) { seen.other = data; return { data: STRATEGY }; } }, { dispatch: (ctx, job) => s2.runStrategyJob(ctx, job.id) });
  await addProgram(f.OTHER);
  const b2 = await f.real.brain(f.otherCtx);
  let a2 = await s2.handle(f.otherCtx, { action: "new_application", funder_name: "Aquaponics Apprenticeship Fund", grant_program_name: "Aquaponics grant", text: "1. Describe aquaponics apprenticeship need." });
  a2 = await s2.handle(f.otherCtx, { action: "save_application", application_id: a2.id, revision: a2.revision, application: { primary_program_id: b2.programs[0].id } });
  await runStrategy(f.otherCtx, a2, s2);
  const pkgs = new Set(research(seen.other).map((x) => x.research.package_version));
  assert.deepEqual([...pkgs], ["VOLUME_OTHER"]);
  assert.equal(JSON.stringify(seen.other).includes("CFSC-001"), false);
  // And this org cannot run strategy on the other org's application.
  await assert.rejects(s.handle(f.ctx, { action: "strategy", application_id: a2.id, revision: a2.revision }), (e) => [403, 404].includes(e.status));
});

test("writer and audit requests stay bounded and within budget at production volume", async () => {
  const brain = await f.real.brain(f.ctx);
  const facts = C.authorizedFacts(brain, app.id);
  const q = { question_text: "Describe youth workforce outcomes in the county", question_category: "need" };
  const evidence = C.retrieve(q, facts, null, brain.documents);
  assert.ok(evidence.length <= 18, "writer retrieval is bounded");
  const { researchRules } = require("../netlify/lib/grant-factory/research");
  const writeReq = { question: q, evidence, claim_rules: researchRules(brain, evidence), methodology_rules: [], strategy: STRATEGY, voice: "" };
  assert.ok(tokens("write", writeReq) <= SE.EVIDENCE_REQUEST_TOKEN_BUDGET, "writer request " + tokens("write", writeReq));
  const auditReq = { question: q, answer: "One sentence.", evidence, claim_rules: researchRules(brain, evidence), methodology_rules: [] };
  assert.ok(tokens("audit", auditReq) <= SE.EVIDENCE_REQUEST_TOKEN_BUDGET, "audit request " + tokens("audit", auditReq));
});

test("the provider refuses an evidence request over budget before contacting the model", async () => {
  let fetched = 0;
  const p = AI.provider({ ANTHROPIC_API_KEY: "k" }, async () => { fetched++; throw Error("should not be called"); });
  const huge = { question: { question_text: "q" }, evidence: [{ value: "x".repeat(SE.EVIDENCE_REQUEST_TOKEN_BUDGET * SE.CHARS_PER_TOKEN) }] };
  await assert.rejects(p.call("write", huge), (e) => e.status === 413 && /Nothing was sent/.test(e.message));
  await assert.rejects(p.call("strategy", huge), (e) => e.status === 413);
  await assert.rejects(p.call("audit", { ...huge, answer: "A sentence." }), (e) => e.status === 413);
  assert.equal(fetched, 0);
  // The hard guard (estimated tokens, which overstate real usage) plus the
  // 4,500-token output allowance stays well inside the context window, and
  // strategy selects evidence below the guard.
  assert.ok(SE.EVIDENCE_REQUEST_TOKEN_BUDGET + 4500 <= SE.MODEL_CONTEXT_TOKENS * 0.8);
  assert.ok(SE.STRATEGY_TOKEN_BUDGET < SE.EVIDENCE_REQUEST_TOKEN_BUDGET);
});

test("selection is deterministic", async () => {
  await runStrategy();
  const a = research(seen.strategy).map((x) => x.id);
  await runStrategy();
  assert.deepEqual(research(seen.strategy).map((x) => x.id), a);
});
