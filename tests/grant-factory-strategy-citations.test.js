"use strict";
// Strategy research citations are allowed only for the records actually
// selected as evidence for that request. A record id that reached the model
// through claim rules, methodology, the crosswalk, funder packets, statistics,
// aliases or other prompt text was never supplied as evidence.
//
// Production failure (2026-09-26): claim rule EM-CR-02 said "use EM-051 for
// the newer county ALICE hardship series". EM-051 was not selected, the model
// cited it with a figure that was not in the request, and the old check passed
// it because the id appeared somewhere in the request text.
const test = require("node:test");
const assert = require("node:assert/strict");
const { researchVolume } = require("./helpers/research-volume");
const { service } = require("../netlify/lib/grant-factory/service");
const SE = require("../netlify/lib/grant-factory/strategy-evidence");

const STRATEGY = { primary_case: "Case", funder_priorities: "Priorities", alignment_points: "Points", themes_to_emphasize: "Themes", themes_to_deemphasize: "None", likely_funding_use: "Staff", evidence_gaps: "Gaps", evidence_chain: "Need to impact", budget_consistency: "No unfunded activities found" };

// ---- The validator on its own -------------------------------------------

const rec = (package_version, record_id) => ({ package_version, record_id });
const sel = (package_version, record_id) => ({ id: "fact-" + record_id, research: rec(package_version, record_id) });
const BUNDLE = {
  records: [rec("ECONOMIC_MOBILITY_V1_2026-09-23", "EM-011"), rec("ECONOMIC_MOBILITY_V1_2026-09-23", "EM-051"), rec("RESEARCH_EVIDENCE_V1_2026-09-23", "CFSC-942"),
    rec("PKG_A_V1_2026-01-01", "X-1"), rec("PKG_B_V1_2026-01-01", "X-1"), rec("CAREER_TECHNICAL_EDUCATION_V1_2026-09-23", "CTE_RESEARCH_004")],
  aliases: [{ package_version: "ECONOMIC_MOBILITY_V1_2026-09-23", legacy_record_id: "EM-OLD-51", canonical_record_id: "EM-051" }],
  rules: [{ package_version: "ECONOMIC_MOBILITY_V1_2026-09-23", rule_id: "EM-CR-02", rule: "Use EM-051 for the newer county ALICE hardship series." }],
  packets: [{ package_version: "ECONOMIC_MOBILITY_V1_2026-09-23", packet_id: "P1", need_evidence_ids: ["EM-051"] }],
  statistics: [{ package_version: "ECONOMIC_MOBILITY_V1_2026-09-23", stat_id: "S1", record_id: "EM-051", finding: "44%" }],
};
const SELECTED = [sel("ECONOMIC_MOBILITY_V1_2026-09-23", "EM-011"), sel("RESEARCH_EVIDENCE_V1_2026-09-23", "CFSC-942"), sel("PKG_A_V1_2026-01-01", "X-1"), sel("CAREER_TECHNICAL_EDUCATION_V1_2026-09-23", "CTE_RESEARCH_004")];
const check = (evidence_chain) => SE.researchCitations({ ...STRATEGY, evidence_chain }, SELECTED, BUNDLE);

test("the production failure class: a rule names EM-051, it was not selected, the model cites it", () => {
  const out = check("Need: Seminole ALICE households (2023): 44% (EM-051 one-year estimate). Local context: EM-011.");
  assert.deepEqual(out.invalid, ["EM-051"]);
  assert.deepEqual(out.cited, ["EM-011"]);
  // The rule, packet and statistic all name EM-051; none of them make it citable.
  assert.ok(JSON.stringify(BUNDLE.rules).includes("EM-051") && JSON.stringify(BUNDLE.packets).includes("EM-051") && JSON.stringify(BUNDLE.statistics).includes("EM-051"));
});

test("a genuinely selected record may be cited, with or without its package", () => {
  for (const text of ["EM-011 supports need.", "EM-011 (ECONOMIC_MOBILITY_V1_2026-09-23) supports need.", "ECONOMIC_MOBILITY_V1_2026-09-23/EM-011 supports need.",
    "EM-011 (package_version ECONOMIC_MOBILITY_V1_2026-09-23)", "CTE_RESEARCH_004 (CAREER_TECHNICAL_EDUCATION_V1) supports pathways."]) {
    const out = check(text);
    assert.deepEqual(out.invalid, [], text);
    assert.equal(out.cited.length, 1, text);
  }
});

test("an unselected record from a packet, statistic or alias is not citable", () => {
  assert.deepEqual(check("Per the funder packet, EM-051 shows need.").invalid, ["EM-051"]);
  assert.deepEqual(check("Statistic S1 (EM-051): 44%.").invalid, ["EM-051"]);
  assert.deepEqual(check("Legacy record EM-OLD-51 shows need.").invalid, ["EM-OLD-51"], "a legacy alias is not a selected record");
});

test("a chain mixing valid and invalid citations is rejected", () => {
  const out = check("Need: EM-011. Research: CFSC-942 (RESEARCH_EVIDENCE_V1_2026-09-23). Local: EM-051 (ECONOMIC_MOBILITY_V1_2026-09-23).");
  assert.deepEqual(out.cited, ["EM-011", "RESEARCH_EVIDENCE_V1_2026-09-23/CFSC-942"]);
  assert.deepEqual(out.invalid, ["ECONOMIC_MOBILITY_V1_2026-09-23/EM-051"]);
});

test("the exact package/record identity is checked, not a coincidental id string", () => {
  // X-1 exists in PKG_A (selected) and PKG_B (not selected).
  assert.deepEqual(check("X-1 (PKG_A_V1_2026-01-01) supports it.").invalid, []);
  assert.deepEqual(check("X-1 (PKG_B_V1_2026-01-01) supports it.").invalid, ["PKG_B_V1_2026-01-01/X-1"]);
  assert.deepEqual(check("PKG_B_V1_2026-01-01/X-1 supports it.").invalid, ["PKG_B_V1_2026-01-01/X-1"]);
  // A selected id named with the wrong package is rejected.
  assert.deepEqual(check("EM-011 (RESEARCH_EVIDENCE_V1_2026-09-23)").invalid, ["RESEARCH_EVIDENCE_V1_2026-09-23/EM-011"]);
  // Look-alikes of a library id are not that id.
  assert.deepEqual(check("EM-0511 and XEM-051 and EM-051A are not records.").invalid, []);
  // Status labels next to an id are not package names.
  assert.deepEqual(check("EM-011 (PRIMARY_VERIFIED) supports need.").invalid, []);
});

test("organization facts, methodology ids and other identifiers are not research citations", () => {
  const out = check("Program fact 229f76fd-99a1-4acc-bda3-7f600b123878 and methodology rule GM-14 frame the case; PLANNING_CROSSWALK_NOT_EVIDENCE.");
  assert.deepEqual(out, { cited: [], invalid: [] });
});

test("every string section is checked, not just evidence_chain", () => {
  const out = SE.researchCitations({ ...STRATEGY, primary_case: "EM-051 shows 44% hardship.", evidence_chain: "EM-011." }, SELECTED, BUNDLE);
  assert.deepEqual(out.invalid, ["EM-051"]);
});

// ---- End to end through the strategy job ---------------------------------

let f, s, seen, reply, app;
test.before(async () => {
  f = await researchVolume();
  f.real.storage = f.repo.storage;
  seen = {};
  reply = null;
  const ai = { enabled: true, async call(task, data) {
    seen[task] = data;
    if (task === "strategy") return { data: reply ? reply(data) : STRATEGY };
    throw Error("Unexpected task " + task);
  } };
  s = service(f.real, ai, { dispatch: (ctx, job) => s.runStrategyJob(ctx, job.id) });
  await f.pg.query("insert into gf_programs(id,org_id,content) values(gen_random_uuid(),$1,$2)", [f.ORG, JSON.stringify({ name: "Youth Workforce Program", status: "ACTIVE", tags: ["youth", "workforce"], description: "Paid work for youth.", verification_status: "APPROVED" })]);
  const program = (await f.real.brain(f.ctx)).programs[0];
  app = await s.handle(f.ctx, { action: "new_application", funder_name: "County Workforce Fund", grant_program_name: "Youth employment grant", text: "1. Describe youth employment need in the county." });
  app = await s.handle(f.ctx, { action: "save_application", application_id: app.id, revision: app.revision, application: { primary_program_id: program.id } });
});
test.after(async () => { await f.pg.close(); });

const fresh = async () => (await s.handle(f.ctx, { action: "get_application", application_id: app.id })).app;
async function runStrategy() {
  const out = await s.handle(f.ctx, { action: "strategy", application_id: app.id, revision: (await fresh()).revision });
  const job = (await f.pg.query("select * from gf_strategy_jobs where id=$1", [out.job.id])).rows[0];
  return { job, app: await fresh() };
}
const selectedIn = (req) => req.facts.filter((x) => x.research).map((x) => x.research);

test("end to end: a rule-only record id cited by the model fails EVIDENCE_CHAIN and nothing is saved", async () => {
  reply = (data) => ({ ...STRATEGY, evidence_chain: "Need: " + selectedIn(data)[0].record_id + " supports it." });
  let { job, app: saved } = await runStrategy();
  assert.equal(job.status, "COMPLETED");
  const before = saved;
  const chosen = selectedIn(seen.strategy);
  // A verified record in a selected package that was not selected.
  const pkg = chosen[0].package_version;
  const picked = new Set(chosen.map((r) => r.package_version + "/" + r.record_id));
  const brain = await f.real.brain(f.ctx);
  const target = brain.research.records.find((r) => r.package_version === pkg && !picked.has(pkg + "/" + r.record_id) && r.verification_status === "PRIMARY_VERIFIED");
  assert.ok(target, "fixture has an unselected record");
  // A package-wide claim rule that names it, the way EM-CR-02 named EM-051.
  await f.pg.query("insert into research_evidence.claim_rules values($1,'CR-KEEP-YEARS','CKY','HIGH','BLOCK',$2)", [pkg,
    JSON.stringify({ package_version: pkg, rule_id: "CR-KEEP-YEARS", title: "Keep data years attached", rule: "Use " + target.record_id + " for the newer county hardship series." })]);
  try {
    reply = (data) => ({ ...STRATEGY, evidence_chain: "Need: county hardship households (2023): 44% (" + target.record_id + " one-year estimate). " + selectedIn(data)[0].record_id + " supports local context." });
    ({ job, app: saved } = await runStrategy());
    // The id did reach the model, but only through the rule.
    const request = JSON.stringify(seen.strategy);
    assert.ok(request.includes(target.record_id), "the rule put the id in the request");
    assert.ok(seen.strategy.claim_rules.some((r) => r.rule_id === "CR-KEEP-YEARS"));
    assert.equal(selectedIn(seen.strategy).some((r) => r.record_id === target.record_id), false, "it was not selected as evidence");
    assert.equal(job.status, "FAILED");
    assert.equal(job.failure_code, "EVIDENCE_CHAIN");
    assert.match(job.last_error, new RegExp(target.record_id));
    assert.deepEqual(job.result.invalid_citations, [target.record_id]);
    assert.equal(saved.revision, before.revision, "nothing saved");
    assert.equal(JSON.stringify(saved.content).includes("44%"), false);
  } finally {
    await f.pg.query("delete from research_evidence.claim_rules where rule_id='CR-KEEP-YEARS'");
  }
});

test("end to end: a crosswalk-linked record that was not selected cannot be cited", async () => {
  const brain = await f.real.brain(f.ctx);
  reply = null;
  await runStrategy();
  const picked = new Set(selectedIn(seen.strategy).map((r) => r.record_id));
  const target = brain.research.records.find((r) => !picked.has(r.record_id) && r.verification_status === "PRIMARY_VERIFIED");
  await f.pg.query("update gf_workspaces set framework=$1 where org_id=$2", [JSON.stringify({
    evidence_crosswalk: { status: "PLANNING_CROSSWALK_NOT_EVIDENCE", entries: [{ component: "Other component", program_ids: ["00000000-0000-4000-8000-00000000abcd"], records: [target.record_id] }] },
    program_alignment: [{ program_id: null, note: "See " + target.record_id + " when planning." }],
  }), f.ORG]);
  try {
    const before = await fresh();
    reply = () => ({ ...STRATEGY, evidence_chain: "Need: " + target.record_id + " proves it." });
    const { job, app: saved } = await runStrategy();
    assert.ok(JSON.stringify(seen.strategy.organization_framework).includes(target.record_id), "the id reached the model as planning text");
    assert.equal(job.failure_code, "EVIDENCE_CHAIN");
    assert.equal(saved.revision, before.revision);
  } finally {
    await f.pg.query("update gf_workspaces set framework=null where org_id=$1", [f.ORG]);
  }
});

test("end to end: selected citations and organization facts save, and the cited list is recorded", async () => {
  reply = (data) => {
    const r = selectedIn(data);
    const org = data.facts.find((x) => !x.research);
    return { ...STRATEGY, evidence_chain: "Need: " + r[0].record_id + " (" + r[0].package_version + "). Local: " + r[1].record_id + ". Program: " + org.id + " (" + org.display_name + "). Method: GM-14." };
  };
  const { job, app: saved } = await runStrategy();
  assert.equal(job.status, "COMPLETED");
  assert.deepEqual(job.result.invalid_citations, []);
  assert.equal(job.result.cited_records.length, 2);
  assert.deepEqual(saved.content.strategy_evidence.cited_records, job.result.cited_records);
  const allow = new Set(saved.content.strategy_evidence.records.map((r) => r.record_id));
  assert.ok(job.result.cited_records.every((c) => allow.has(c.split("/").pop())));
  assert.equal(saved.content.strategy.approved, false);
});

test("evidence selection, ranking, the 40-record cap and the 120,000-token budget are unchanged", async () => {
  assert.equal(SE.STRATEGY_RESEARCH_MAX, 40);
  assert.equal(SE.STRATEGY_TOKEN_BUDGET, 120000);
  assert.equal(SE.EVIDENCE_REQUEST_TOKEN_BUDGET, 150000);
  assert.equal(SE.CHARS_PER_TOKEN, 3);
  assert.equal(SE.PACKAGE_SHARE, 0.6);
  // Validation does not influence selection: the same inputs select the same
  // records whether the model's citations pass or fail.
  reply = null;
  await runStrategy();
  const a = selectedIn(seen.strategy).map((r) => r.package_version + "/" + r.record_id);
  reply = () => ({ ...STRATEGY, evidence_chain: "Need: NOT-A-RECORD-1." });
  await runStrategy();
  const b = selectedIn(seen.strategy).map((r) => r.package_version + "/" + r.record_id);
  assert.deepEqual(a, b);
  assert.ok(a.length > 0 && a.length <= 40);
  assert.ok(SE.estimateTokens(SE.size(seen.strategy)) <= SE.STRATEGY_TOKEN_BUDGET);
});
