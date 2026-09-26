"use strict";
// Research-derived findings must cite their selected record id in the same
// sentence, and the evidence chain must cite the records it relies on.
//
// Production example (2026-09-26, revision 41): the strategy named sources
// instead of records ("Kaiser et al. meta-analysis, 76 RCTs", "84% of
// national employers", "(NACE, Chamber)"). Every number traced to a selected
// record, but none carried its record id and the evidence chain cited none.
//
// Also: the PR #30 validator took about 30 seconds on production evidence;
// it must now finish in well under a second.
const test = require("node:test");
const assert = require("node:assert/strict");
const SQ = require("../netlify/lib/grant-factory/strategy-quantities");
const SE = require("../netlify/lib/grant-factory/strategy-evidence");
const AI = require("../netlify/lib/grant-factory/ai");
const { researchVolume } = require("./helpers/research-volume");
const { service } = require("../netlify/lib/grant-factory/service");

const SECTIONS = ["primary_case", "funder_priorities", "alignment_points", "themes_to_emphasize", "themes_to_deemphasize", "likely_funding_use", "evidence_gaps", "evidence_chain", "budget_consistency"];
const STRATEGY = { primary_case: "Case", funder_priorities: "Priorities", alignment_points: "Points", themes_to_emphasize: "Themes", themes_to_deemphasize: "None", likely_funding_use: "Staff", evidence_gaps: "Gaps", evidence_chain: "Need to impact", budget_consistency: "No unfunded activities found" };
const PKG = "PKG_V1_2026-01-01";

const fact = (id, value) => ({ id, display_name: id, value, category: "Organization", verification_status: "APPROVED" });
const research = (record_id, finding, source_org) => ({ id: "r-" + record_id, research: { package_version: PKG, record_id, finding, source_org }, selection: { rank: 1, reasons: ["planning aid"] } });
const REQUEST = {
  application: { funder_name: "County Workforce Fund", allowable_costs: "Staff and student wages up to $250,000 per year", match_requirement: "25% cash match required" },
  questions: [{ question_text: "Describe your program. Maximum 150 words." }],
  program: { name: "Youth Workforce Program" },
  facts: [
    fact("enrollment", "The Academy plans to enroll approximately 150 students."),
    fact("history", "Over ten years, Bright Minds served 700+ youth."),
    fact("dual", "Dual enrollment is planned with Valencia College."),
    research("EP-018", "84% of employers agree most high school students are unprepared; 96% value financial literacy for career starters.", "National Association of Colleges and Employers (NACE)"),
    research("NC-029", "The median youth wage was $14.50 per hour in 2024.", "Bureau of Labor Statistics"),
    research("CB-007", "A meta-analysis of 62 service-learning studies found effects of 0.27-0.43 on civic outcomes.", "Search Institute"),
    research("EM-011", "Seminole County graduation rate was 94.4% in 2024-25.", "Valencia College"),
  ],
};
const SELECTED = REQUEST.facts.filter((f) => f.research);
const BUNDLE = {
  records: [...SELECTED.map((f) => f.research), { package_version: PKG, record_id: "EM-051", finding: "44% of households are below the ALICE threshold." }],
  aliases: [{ package_version: PKG, legacy_record_id: "EM-OLD-11", canonical_record_id: "EM-011" }],
  rules: [{ package_version: PKG, rule_id: "CR-2", rule: "Use EM-051 for the newer county ALICE hardship series." }],
};
// Everything the job checks after the model returns: the PR #29 allowlist
// and the quantity and research-citation analysis.
function validate(strategy) {
  const citations = SE.researchCitations(strategy, SELECTED, BUNDLE);
  const a = SQ.analyze(strategy, REQUEST, BUNDLE);
  return { invalid: citations.invalid, unsupported: a.unsupported, uncited: a.uncited, cited: a.cited };
}
const s = (section, text, chain = "Evidence: employer demand [EP-018] supports need; does not support local wages.") =>
  ({ ...STRATEGY, evidence_chain: chain, [section]: section === "evidence_chain" ? text : text });
const ok = (strategy) => { const v = validate(strategy); assert.deepEqual([v.invalid, v.unsupported, v.uncited], [[], [], []], JSON.stringify(v)); return v; };
const uncited = (strategy, re) => { const v = validate(strategy); assert.ok(v.uncited.length, "expected an uncited research finding"); if (re) assert.ok(v.uncited.some((u) => re.test(u.text + " " + u.reason)), JSON.stringify(v.uncited)); return v; };

test("a research finding with its selected canonical id is accepted", () => {
  const v = ok(s("evidence_chain", "Need: 84% of employers agree most high school students are unprepared [EP-018]; supports employer demand, does not support local wages."));
  assert.deepEqual(v.cited, ["EP-018"]);
  ok(s("themes_to_emphasize", "Employer demand: 96% value financial literacy [EP-018]."));
  ok(s("themes_to_emphasize", "Employer demand: 96% value financial literacy (EP-018, " + PKG + ")."));
});

test("a research finding with no id is rejected", () => {
  uncited(s("alignment_points", "A meta-analysis found service-learning improves civic outcomes."), /meta-analysis/);
  uncited(s("alignment_points", "Research shows paid work builds professional skills."), /Research shows/);
});

test("an author or source name without a record id is rejected", () => {
  uncited(s("alignment_points", "Financial education improves knowledge (Kaiser et al. meta-analysis, 76 RCTs)."), /et al/);
  uncited(s("alignment_points", "Employers prefer communication and teamwork (NACE)."), /NACE/);
  uncited(s("alignment_points", "According to the Search Institute, developmental relationships matter."), /Search Institute/);
  // The same name with the id is accepted.
  ok(s("alignment_points", "Employers prefer communication and teamwork (NACE) [EP-018]."));
});

test("author surnames and journals from the record count as sources", () => {
  const req = { ...REQUEST, facts: [...REQUEST.facts, { id: "r-X", research: { package_version: PKG, record_id: "CFSC-914", finding: "Mentoring produces modest gains.", source_authors: "Burch, G. F.; Giambatista, R.", source_org: "Decision Sciences Journal of Innovative Education, Wiley, 17(3), 239-273" }, selection: {} }] };
  const a = SQ.analyze({ ...STRATEGY, evidence_chain: "Need: 96% value financial literacy [EP-018].", alignment_points: "Mentoring produces modest gains (Burch, 2019)." }, req, BUNDLE);
  assert.ok(a.uncited.some((u) => /Burch/.test(u.reason)), JSON.stringify(a.uncited));
  const b = SQ.analyze({ ...STRATEGY, evidence_chain: "Need: 96% value financial literacy [EP-018].", alignment_points: "Mentoring produces modest gains (Decision Sciences Journal of Innovative Education)." }, req, BUNDLE);
  assert.ok(b.uncited.length, JSON.stringify(b));
  const c = SQ.analyze({ ...STRATEGY, evidence_chain: "Need: 96% value financial literacy [EP-018].", alignment_points: "Mentoring produces modest gains (Burch, 2019) [CFSC-914]." }, req, BUNDLE);
  assert.deepEqual(c.uncited, []);
});

test("a research percentage without an id in the same sentence is rejected, even if the id appears later", () => {
  uncited(s("themes_to_emphasize", "84% of employers agree most students are unprepared. Employers want readiness. Evidence list: EP-018, NC-029."), /84%/);
  uncited(s("evidence_chain", "Need: 84% of employers agree most students are unprepared.\nSources: EP-018 (employer survey) supports demand."), /84%/);
  // A citation standing on its own right after the sentence belongs to it.
  ok(s("evidence_chain", "Need: 84% of employers agree most students are unprepared.\n[EP-018]"));
});

test("a research percentage with its selected supporting id is accepted", () => {
  ok(s("evidence_chain", "Local context: Seminole graduation 94.4% (2024-25) [EM-011] supports a strong baseline; does not support a deficit."));
  ok(s("alignment_points", "Service-learning effects of 0.27-0.43 [CB-007] support civic design."));
});

test("a research number cited to a selected record that does not contain it is rejected", () => {
  uncited(s("themes_to_emphasize", "84% of employers agree most students are unprepared [NC-029]."), /does not contain/);
  uncited(s("alignment_points", "Service-learning effects of 0.27-0.43 [EP-018]."), /does not contain this value/);
});

test("unitless research values need their record id too", () => {
  uncited(s("alignment_points", "Service-learning shows moderate effects (0.27-0.43)."), /0\.27/);
});

test("an unselected canonical id is rejected", () => {
  const v = validate(s("evidence_chain", "Need: 44% of households are below the ALICE threshold [EM-051]."));
  assert.deepEqual(v.invalid, ["EM-051"]);
});

test("a legacy alias does not stand in for the canonical id", () => {
  const v = validate(s("evidence_chain", "Local context: graduation 94.4% [EM-OLD-11] supports a strong baseline."));
  assert.deepEqual(v.invalid, ["EM-OLD-11"]);
  assert.ok(v.uncited.some((u) => /94\.4%/.test(u.text)), "the number is not cited by a canonical id");
});

test("a rule-only or crosswalk-only id is rejected", () => {
  // EM-051 appears in a claim rule only; it is not selected.
  const v = validate(s("evidence_chain", "Hardship: EM-051 shows the newer series."));
  assert.deepEqual(v.invalid, ["EM-051"]);
});

test("organization-fact and application numbers do not require research citations", () => {
  ok({ ...STRATEGY, primary_case: "The Academy plans approximately 150 students; Bright Minds served 700+ youth over ten years." });
  ok({ ...STRATEGY, budget_consistency: "Established: wages allowable up to $250,000 per year; 25% cash match required.\nGaps: student wage rate not yet established." });
  // A source that is also named in the organization facts (a partner) is an
  // ordinary mention, not research.
  ok({ ...STRATEGY, alignment_points: "Dual enrollment is planned with Valencia College (a partner)." });
});

test("an evidence chain that describes research without record ids is rejected", () => {
  uncited({ ...STRATEGY, evidence_chain: "Research evidence: financial education improves knowledge (Kaiser et al. meta-analysis, 76 RCTs); employer preferences for communication (NACE)." }, /evidence|et al|NACE/);
  // Research used elsewhere with ids, but the chain cites none.
  const v = uncited({ ...STRATEGY, themes_to_emphasize: "96% value financial literacy [EP-018].", evidence_chain: "Need to program response to impact; no local outcome data yet." });
  assert.ok(v.uncited.some((u) => /evidence chain cites no selected record id/.test(u.reason)));
});

test("selected but unused evidence does not have to be cited", () => {
  const v = ok({ ...STRATEGY, evidence_chain: "Need: 96% value financial literacy [EP-018]; supports demand, does not support local need." });
  assert.deepEqual(v.cited, ["EP-018"]);
});

test("all nine strategy sections are checked", () => {
  for (const section of SECTIONS) {
    const strategy = { ...STRATEGY, evidence_chain: "Need: 96% value financial literacy [EP-018].", [section]: (section === "evidence_chain" ? "Need: 96% value financial literacy [EP-018]. " : "") + "84% of employers agree most students are unprepared." };
    const v = validate(strategy);
    assert.ok(v.uncited.some((u) => u.section === section && /84%/.test(u.text)), section + ": " + JSON.stringify(v.uncited));
  }
});

test("a strategy that uses no research needs no citations", () => {
  ok({ ...STRATEGY, evidence_gaps: "Established: 700+ youth served.\nGaps: no cohort outcome rate.\nDecisions and actions: set a measurement plan." });
});

test("the prompt shows the citation format without growing much", () => {
  const p = AI.systemPrompt("strategy");
  assert.match(p, /in brackets right after each research-derived finding in the same sentence/);
  assert.match(p, /\[ABC-012\]/);
  assert.match(p, /an author, study or source name alone is not a citation/);
  assert.ok(p.length < 4300, "prompt length " + p.length);
});

// ---- Performance --------------------------------------------------------

// A production-sized request: 200 organization facts, 24 research records of
// about 7,000 characters each full of ranges ("2016-2026", "9-11", "0.21-0.41",
// "$5k-$9k"), and a 22,000-character strategy with 160 cited statistics. The
// previous implementation did not finish on this input.
function productionSized() {
  const w = (n, k) => Array.from({ length: n }, (_, i) => ["youth", "workforce", "county", "households", "employment", "program", "evidence", "outcomes", "survey", "region"][(i + k) % 10]).join(" ");
  const facts = [];
  for (let i = 0; i < 200; i++) facts.push({ ...fact("f" + i, w(60, i) + " served " + (100 + i) + " students from 2016–2026 in grades 9–12, budget $" + (1000 * i) + " and " + (i % 50) + "% match"), notes: w(40, i) });
  for (let r = 0; r < 24; r++) {
    const parts = [];
    for (let k = 0; k < 40; k++) parts.push(w(12, k + r) + " rates rose " + (10 + k) + "% to " + (20 + k) + "% between 2016–2024, effects 0.2" + k + "–0.4" + k + ", ages 14–18, $" + (5 + k) + "k–$" + (9 + k) + "k per year, " + (3 + k) + "–" + (6 + k) + " hours/week");
    facts.push(research("RX-" + String(r).padStart(3, "0"), parts.join(". "), "Example Institute " + r));
  }
  const lines = [];
  for (let i = 0; i < 160; i++) lines.push("Point " + i + ": " + w(10, i) + " rose " + (10 + (i % 40)) + "% [RX-" + String(i % 24).padStart(3, "0") + "] across 2016–2026, grades 9–11, with effects 0.2" + (i % 40) + "–0.4" + (i % 40) + ".");
  const text = lines.join(" ");
  const strategy = { ...STRATEGY, primary_case: text.slice(0, 3000), alignment_points: text.slice(3000, 6000), themes_to_emphasize: text.slice(6000, 9000), evidence_gaps: text.slice(9000, 13000), evidence_chain: text.slice(13000, 22000) };
  const request = { facts, application: REQUEST.application, questions: REQUEST.questions, program: REQUEST.program };
  const bundle = { records: facts.filter((f) => f.research).map((f) => f.research), aliases: [] };
  return { request, strategy, bundle, selected: facts.filter((f) => f.research) };
}

test("validation finishes in under one second on production-sized data, with every check running", () => {
  const { request, strategy, bundle, selected } = productionSized();
  assert.ok(JSON.stringify(request).length > 350000, "request is production-sized");
  const started = process.hrtime.bigint();
  const citations = SE.researchCitations(strategy, selected, bundle);
  const a = SQ.analyze(strategy, request, bundle);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 1000, "validation took " + Math.round(ms) + " ms");
  // The checks really ran: every statistic was found and attributed.
  assert.deepEqual(citations.invalid, []);
  assert.ok(a.cited.length > 0);
  assert.equal(a.unsupported.length + a.uncited.length > 0 || a.cited.length > 0, true);
  // And a planted problem is still caught at this size.
  const planted = SQ.analyze({ ...strategy, budget_consistency: "Students earn $15/hour. A meta-analysis found gains." }, request, bundle);
  assert.ok(planted.unsupported.some((u) => u.text === "$15/hour"));
  assert.ok(planted.uncited.some((u) => /meta-analysis/.test(u.reason)));
});

// ---- End to end through the strategy job ---------------------------------

let f, svc, reply, app;
test.before(async () => {
  f = await researchVolume();
  f.real.storage = f.repo.storage;
  reply = null;
  const ai = { enabled: true, async call(task, data) {
    if (task === "strategy") return { data: reply ? reply(data) : STRATEGY };
    throw Error("Unexpected task " + task);
  } };
  svc = service(f.real, ai, { dispatch: (ctx, job) => svc.runStrategyJob(ctx, job.id) });
  await f.pg.query("insert into gf_programs(id,org_id,content) values(gen_random_uuid(),$1,$2)", [f.ORG, JSON.stringify({ name: "Youth Workforce Program", status: "ACTIVE", tags: ["youth", "workforce"], description: "Paid work for youth.", verification_status: "APPROVED" })]);
  const program = (await f.real.brain(f.ctx)).programs[0];
  app = await svc.handle(f.ctx, { action: "new_application", funder_name: "County Workforce Fund", grant_program_name: "Youth employment grant", text: "1. Describe youth employment need in the county." });
  app = await svc.handle(f.ctx, { action: "save_application", application_id: app.id, revision: app.revision, application: { primary_program_id: program.id } });
});
test.after(async () => { await f.pg.close(); });

const fresh = async () => (await svc.handle(f.ctx, { action: "get_application", application_id: app.id })).app;
async function runStrategy() {
  const out = await svc.handle(f.ctx, { action: "strategy", application_id: app.id, revision: (await fresh()).revision });
  return { job: (await f.pg.query("select * from gf_strategy_jobs where id=$1", [out.job.id])).rows[0], app: await fresh() };
}
const selectedIn = (req) => req.facts.filter((x) => x.research).map((x) => x.research);

test("end to end: research named without record ids fails EVIDENCE_CHAIN and nothing is saved", async () => {
  reply = null;
  const before = (await runStrategy()).app;
  reply = () => ({ ...STRATEGY, evidence_chain: "Research evidence: financial education improves knowledge (Kaiser et al. meta-analysis, 76 RCTs)." });
  const { job, app: saved } = await runStrategy();
  assert.equal(job.status, "FAILED");
  assert.equal(job.failure_code, "EVIDENCE_CHAIN");
  assert.match(job.last_error, /must cite their selected record id/);
  assert.ok(job.result.uncited_research.length);
  assert.equal(typeof job.result.validation_ms, "number");
  assert.equal(saved.revision, before.revision, "nothing saved");
});

test("end to end: cited research findings save, with the cited records and validation time recorded", async () => {
  reply = (data) => {
    const r = selectedIn(data)[0];
    const finding = String(r.finding);
    const pct = /(\d+(?:\.\d+)?)%/.exec(finding);
    return { ...STRATEGY, evidence_chain: "Need: " + (pct ? pct[0] + " " : "") + "finding [" + r.record_id + "] supports local need; does not support program effect." };
  };
  const { job, app: saved } = await runStrategy();
  assert.equal(job.status, "COMPLETED", job.last_error + " " + JSON.stringify(job.result.uncited_research || job.result.unsupported_quantities));
  assert.deepEqual(job.result.uncited_research, []);
  assert.ok(job.result.validation_ms < 1000, "validation " + job.result.validation_ms + " ms");
  assert.equal(saved.content.strategy_evidence.cited_records.length, 1);
});
