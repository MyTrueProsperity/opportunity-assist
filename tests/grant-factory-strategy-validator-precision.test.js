"use strict";
// Validator precision after the PR #32 production validation (2026-09-26).
// Two fresh strategies were rejected. The rejections that were right:
//   "... (supported by research)" and "national research base supporting ..."
//   with no record id.
// The false positives this fixes:
//   "... are not documented in supplied evidence" (a gap, not a claim);
//   "requires committed scholarship funding source and estimated ..."
//   ("scholarship" means financial aid);
//   "10-year" history, matched only by "10-years" inside a CNE-015 web
//   address, while the organization facts say "Over ten years".
// Also: a rejected strategy is kept on the FAILED job for diagnosis.
const test = require("node:test");
const assert = require("node:assert/strict");
const SQ = require("../netlify/lib/grant-factory/strategy-quantities");
const SE = require("../netlify/lib/grant-factory/strategy-evidence");
const SA = require("../netlify/lib/grant-factory/strategy-attribution");
const { researchVolume } = require("./helpers/research-volume");
const { service } = require("../netlify/lib/grant-factory/service");

const SECTIONS = ["primary_case", "funder_priorities", "alignment_points", "themes_to_emphasize", "themes_to_deemphasize", "likely_funding_use", "evidence_gaps", "evidence_chain", "budget_consistency"];
const STRATEGY = { primary_case: "Case", funder_priorities: "Priorities", alignment_points: "Points", themes_to_emphasize: "Themes", themes_to_deemphasize: "None", likely_funding_use: "Staff", evidence_gaps: "Gaps", evidence_chain: "Need to impact", budget_consistency: "No unfunded activities found" };
const PKG = "PKG_V1_2026-01-01";
const fact = (id, value) => ({ id, display_name: id, value, category: "Organization", verification_status: "APPROVED" });
const research = (record_id, r) => ({ id: "r-" + record_id, display_name: record_id + " · " + r.topic, value: r.approved_language || r.finding, research: { package_version: PKG, record_id, ...r }, selection: { rank: 1, reasons: ["planning aid"] } });

const HISTORY = "The Institute of Bright Minds is the next stage of a model that has been operating since 2016. Over ten years, Bright Minds has developed from one internship into a multi-track youth workforce and research initiative.";
// CNE-015 as production holds it: "10-years" only inside a web address.
const CNE015 = {
  topic: "Developmental relationships framework",
  finding: "Young people who experience strong developmental relationships report more positive outcomes.",
  supports: ["Relationship-rich youth settings."],
  source_org: "Search Institute",
  source_url: "https://searchinstitute.org/10-years-of-developmental-relationships",
  sources: [{ title: "Developmental Relationships Framework", locator: "Framework resource page; https://searchinstitute.org/10-years-of-developmental-relationships", publisher: "Search Institute" }],
  approved_language: "Search Institute reports (https://searchinstitute.org/10-years-of-developmental-relationships): young people who experience strong developmental relationships report more positive outcomes.",
};
const EP018 = { topic: "Employer views of workforce readiness", finding: "84% of employers agree most high school students are not prepared to enter the workforce; 96% value financial literacy for career starters.", supports: ["Employer interest in financial capability and demonstrated workplace skills."], source_org: "U.S. Chamber of Commerce" };
const CB007 = { topic: "Service-learning meta-analysis", finding: "A meta-analysis of 62 studies found significant benefits across five outcome domains, with mean effects between 0.27 and 0.43.", supports: ["Well-designed service-learning can contribute to civic, social, academic and self-related development."], source_org: "Celio, Durlak and Dymnicki" };
const EM039 = { topic: "Career academies and long-term earnings", finding: "Annual earnings averaged 11% higher over eight years. Postsecondary credential attainment did not increase relative to controls.", supports: ["Integrated academic, technical and employer-linked learning can improve earnings."], does_not_support: ["Do not claim that the study increased college completion."] };

const REQUEST = {
  application: { funder_name: "County Workforce Fund", allowable_costs: "Staff and student wages up to $250,000 per year" },
  questions: [{ question_text: "Describe your program. Maximum 150 words." }],
  program: { name: "Bright Minds Professional Academy" },
  facts: [
    fact("history", HISTORY),
    fact("fees", "The Academy plans a registration fee of approximately $200; the tuition model is not yet decided."),
    research("EP-018", EP018), research("CB-007", CB007), research("EM-039", EM039), research("CNE-015", CNE015),
  ],
};
const SELECTED = REQUEST.facts.filter((f) => f.research);
const BUNDLE = {
  records: [...SELECTED.map((f) => f.research), { package_version: PKG, record_id: "EM-051", finding: "44% of households are below the ALICE threshold." }],
  aliases: [{ package_version: PKG, legacy_record_id: "EP-OLD-18", canonical_record_id: "EP-018" }],
};
const CHAIN = "Need: 84% of employers agree most high school students are not prepared [EP-018]; supports employer demand, does not support local need.";
const withSection = (section, text, request = REQUEST) => ({ ...STRATEGY, evidence_chain: CHAIN, [section]: section === "evidence_chain" ? CHAIN + " " + text : text });
function validate(strategy, request = REQUEST) {
  const citations = SE.researchCitations(strategy, request.facts.filter((f) => f.research), BUNDLE);
  const a = SQ.analyze(strategy, request, BUNDLE);
  return { invalid: citations.invalid, unsupported: a.unsupported, uncited: a.uncited, cited: a.cited };
}
const ok = (strategy, request) => { const v = validate(strategy, request); assert.deepEqual([v.invalid, v.unsupported, v.uncited], [[], [], []], JSON.stringify(v)); return v; };
const rejected = (strategy, re, request) => {
  const v = validate(strategy, request);
  const all = [...v.uncited, ...v.unsupported].map((u) => u.text + " | " + u.reason);
  assert.ok(v.invalid.length || all.length, "expected a rejection");
  if (re) assert.ok(all.some((x) => re.test(x)) || v.invalid.some((x) => re.test(x)), JSON.stringify(v));
  return v;
};

test("1. scholarship meaning financial aid needs no research citation", () => {
  // The exact production sentence.
  ok(withSection("budget_consistency", "(8) Enrollment support including scholarships (approximate $200 registration fee planned; full tuition model unclear), requires committed scholarship funding source and estimated amounts."));
  ok(withSection("likely_funding_use", "Scholarships support students whose families cannot pay tuition."));
  assert.equal(SA.attribution("Scholarship funds estimated at the board's discretion cover fees."), null);
});

test("2-3. statements of absent evidence are gaps, not research claims", () => {
  // The exact production sentence.
  ok(withSection("evidence_gaps", "Gaps: (1) funder priorities; (4) Seminole County-specific youth needs, ALICE household prevalence, financial literacy baseline, or postsecondary access barriers are not documented in supplied evidence."));
  ok(withSection("evidence_gaps", "(4) Seminole County-specific youth needs are not documented in supplied evidence."));
  for (const sentence of [
    "No evidence was supplied on local prevalence.",
    "Local need is not established by the available research.",
    "The application does not document match sources.",
    "Evidence is insufficient to establish program effects for Bright Minds.",
    "There is no evidence showing local effects.",
    "A lack of research demonstrating transfer to Florida youth remains.",
    "Program effects are not supported by the supplied research.",
  ]) ok(withSection("evidence_gaps", sentence));
});

test("4-5. affirmative research attributions without a selected id are rejected", () => {
  rejected(withSection("themes_to_emphasize", "Research supports paid, supervised work for youth."), /Research supports/);
  // The exact production sentences.
  rejected(withSection("evidence_gaps", "Established: 10+ years of operations; 30+ postsecondary institutions; historical participant source (ALICE and low-moderate-income Central Florida households); national research base supporting work-based learning and service learning."), /research base supporting/);
  rejected(withSection("themes_to_emphasize", "Highlight nonpartisan community service (John Doe Society) and authentic arts/media production (The Junction) as belonging and engagement mechanisms (supported by research)."), /supported by research/);
  // Negation after the verb is still a claim about what research found.
  rejected(withSection("alignment_points", "Research shows service-learning has no downside."), /Research shows/);
  // Other affirmative wording stays covered.
  for (const sentence of ["Empirical evidence indicates reflection matters.", "Evaluation findings show gains for mentored youth.", "The literature documents service-learning benefits.", "Studies demonstrate that service-learning builds civic development.", "National surveys document employer demand for communication."])
    rejected(withSection("alignment_points", sentence));
});

test("6. a research-attributed summary with its selected supporting id is accepted", () => {
  ok(withSection("themes_to_emphasize", "Service-learning with reflection builds civic, social and academic development (supported by research [CB-007])."));
  ok(withSection("evidence_gaps", "Established: national research base supporting civic, social and academic development through service-learning [CB-007]."));
  ok(withSection("themes_to_emphasize", "Research supports employer demand for financial literacy [EP-018]."));
});

test("7. 10-years inside a research-record URL does not support an Institute 10-year claim", () => {
  const noHistory = { ...REQUEST, facts: REQUEST.facts.filter((f) => f.id !== "history") };
  const v = rejected(withSection("themes_to_emphasize", "Emphasize the Institute's 10-year track record of youth development."), /10-year/, noHistory);
  assert.ok(v.unsupported.some((u) => u.text === "10-year"), JSON.stringify(v));
  assert.ok(!v.uncited.some((u) => /CNE-015/.test(u.reason)), "the URL is not research support: " + JSON.stringify(v.uncited));
  // Nor does citing CNE-015 make the URL number support it.
  rejected(withSection("themes_to_emphasize", "Emphasize the 10-year track record of developmental relationships [CNE-015]."), /10-year/, noHistory);
});

test("8. an organization fact stating ten years supports a 10-year history", () => {
  // The production failure: "10-year" in themes_to_emphasize.
  ok(withSection("themes_to_emphasize", "Emphasize the Institute's 10-year track record."));
  ok(withSection("themes_to_emphasize", "Highlight the 10-year history of practical youth formation."));
  ok(withSection("primary_case", "Bright Minds brings a ten-year history of youth workforce programming."));
  ok(withSection("primary_case", "Over ten years, Bright Minds has built a multi-track youth workforce initiative."));
});

test("9. different quantities remain non-equivalent", () => {
  rejected(withSection("themes_to_emphasize", "Emphasize the Institute's 12-year track record."), /12-year/);
  rejected(withSection("themes_to_emphasize", "Emphasize a 10-month track record."), /10-month/);
  // Ten years of history does not support a ten-year grant period.
  rejected(withSection("likely_funding_use", "Request support across a 10-year grant period."), /10-year/);
  rejected(withSection("budget_consistency", "Registration fee of approximately $250 per student."), /\$250/);
});

test("10. the PR #29 selected-evidence allowlist is enforced", () => {
  assert.deepEqual(validate(withSection("evidence_chain", "Hardship: 44% of households are below ALICE [EM-051].")).invalid, ["EM-051"]);
  assert.deepEqual(validate(withSection("alignment_points", "Research shows employer demand for financial literacy [EP-OLD-18].")).invalid, ["EP-OLD-18"]);
});

test("11. PR #30 applicant quantitative grounding is enforced", () => {
  const v = rejected(withSection("budget_consistency", "Students earn $15/hour for 10 hours/week."), /\$15\/hour/);
  assert.ok(v.unsupported.length);
  ok(withSection("budget_consistency", "Established: wages allowable up to $250,000 per year; registration fee of approximately $200.\nGaps: student wage rate not yet established."));
});

test("12. PR #31 same-sentence research-number citation is enforced", () => {
  rejected(withSection("themes_to_emphasize", "84% of employers agree most students are not prepared."), /84%/);
  rejected(withSection("themes_to_emphasize", "84% of employers agree most students are not prepared [CB-007]."), /does not contain this number/);
  rejected(withSection("alignment_points", "Service-learning shows moderate effects (0.27-0.43)."), /0\.27/);
});

test("13. PR #32 affirmative attribution and substantive support are enforced in all nine sections", () => {
  for (const section of SECTIONS) {
    const a = validate(withSection(section, "National surveys document employer demand for communication."));
    assert.ok(a.uncited.some((u) => u.section === section && /surveys document/.test(u.reason)), section);
    const b = validate(withSection(section, "Career academies improved credential attainment [EM-039]."));
    assert.ok(b.uncited.some((u) => u.section === section && /EM-039 reports no improvement/.test(u.reason)), section);
  }
  rejected(withSection("alignment_points", "Research shows mentoring improves reading scores [EP-018]."), /does not report this claim/);
});

test("16. production-sized validation stays well under one second", () => {
  const w = (n, k) => Array.from({ length: n }, (_, i) => ["youth", "workforce", "county", "households", "employment", "program", "evidence", "outcomes", "survey", "region"][(i + k) % 10]).join(" ");
  const facts = [fact("history", HISTORY)];
  for (let i = 0; i < 200; i++) facts.push({ ...fact("f" + i, w(60, i) + " served " + (100 + i) + " students from 2016–2026 in grades 9–12, budget $" + (1000 * i) + " and " + (i % 50) + "% match; see https://example.org/reports/" + i + "-years/" + (i * 7) + "-percent"), notes: w(40, i) });
  for (let r = 0; r < 24; r++) {
    const parts = [];
    for (let k = 0; k < 40; k++) parts.push(w(12, k + r) + " rates rose " + (10 + k) + "% to " + (20 + k) + "% between 2016–2024, effects 0.2" + k + "–0.4" + k + ", ages 14–18, $" + (5 + k) + "k–$" + (9 + k) + "k per year, " + (3 + k) + "–" + (6 + k) + " hours/week");
    facts.push(research("RX-" + String(r).padStart(3, "0"), { topic: w(4, r), finding: parts.join(". "), supports: [w(12, r)], source_url: "https://example.org/" + r + "-years-of-research/" + (r * 3) + "%", sources: [{ locator: "https://example.org/" + r + "0-years" }], source_org: "Example Institute " + r }));
  }
  const lines = [];
  for (let i = 0; i < 160; i++) lines.push("Point " + i + ": research shows " + w(10, i) + " rose " + (10 + (i % 40)) + "% [RX-" + String(i % 24).padStart(3, "0") + "] across 2016–2026, while outcome data are not documented in supplied evidence for the county.");
  const text = lines.join(" ");
  const strategy = { ...STRATEGY, primary_case: "Over ten years of operation. " + text.slice(0, 3000), alignment_points: text.slice(3000, 6000), themes_to_emphasize: text.slice(6000, 9000), evidence_gaps: text.slice(9000, 13000), evidence_chain: text.slice(13000, 24000) };
  const request = { facts, application: REQUEST.application, questions: REQUEST.questions, program: REQUEST.program };
  const bundle = { records: facts.filter((f) => f.research).map((f) => f.research), aliases: [] };
  assert.ok(JSON.stringify(request).length > 350000, "request is production-sized");
  const started = process.hrtime.bigint();
  const citations = SE.researchCitations(strategy, facts.filter((f) => f.research), bundle);
  const a = SQ.analyze(strategy, request, bundle);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 1000, "validation took " + Math.round(ms) + " ms");
  assert.deepEqual(citations.invalid, []);
  assert.ok(a.cited.length > 0);
  const planted = SQ.analyze({ ...strategy, budget_consistency: "Students earn $15/hour. Studies demonstrate gains in youth employment." }, request, bundle);
  assert.ok(planted.unsupported.some((u) => u.text === "$15/hour"));
  assert.ok(planted.uncited.some((u) => /Studies demonstrate/.test(u.reason)));
});

// ---- Rejected output for diagnosis ----------------------------------------

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
const REJECTED_TEXT = "Research shows paid work builds professional skills and national surveys document employer demand.";

test("14. rejected output is available for authorized diagnosis but never becomes the strategy", async () => {
  reply = null;
  const before = (await runStrategy()).app;
  reply = () => ({ ...STRATEGY, alignment_points: REJECTED_TEXT, evidence_chain: "Need to impact; no local outcome data yet." });
  const { job, app: saved } = await runStrategy();
  assert.equal(job.status, "FAILED");
  assert.equal(job.failure_code, "EVIDENCE_CHAIN");
  assert.equal(job.result.rejected, true);
  assert.equal(job.result.rejected_strategy.alignment_points, REJECTED_TEXT, "complete rejected text is kept");
  assert.equal(Object.keys(job.result.rejected_strategy).length, 9);
  // Not saved on the application, not approvable, not usable for drafting.
  assert.equal(saved.revision, before.revision);
  assert.notEqual(saved.content.strategy?.alignment_points, REJECTED_TEXT);
  assert.equal(JSON.stringify(saved.content).includes(REJECTED_TEXT), false);
  // The status poll carries the short error, not the rejected output.
  assert.equal(JSON.stringify(await svc.handle(f.ctx, { action: "strategy_status", application_id: app.id })).includes("rejected_strategy"), false);
  const { rejection } = await svc.handle(f.ctx, { action: "strategy_rejection", application_id: app.id });
  assert.equal(rejection.status, "REJECTED");
  assert.equal(rejection.job_status, "FAILED");
  assert.equal(rejection.current, false);
  assert.equal(rejection.approvable, false);
  assert.equal(rejection.rejected_strategy.alignment_points, REJECTED_TEXT);
  assert.ok(rejection.uncited_research.length);
  // Approving what is on the application never picks up the rejected text.
  const approved = await svc.handle(f.ctx, { action: "save_application", application_id: app.id, revision: saved.revision, application: { strategy_approved: true } }).catch((e) => e);
  assert.equal(JSON.stringify(approved).includes(REJECTED_TEXT), false);
  // A later job replaces it: an application keeps at most one rejected output.
  reply = () => ({ ...STRATEGY, alignment_points: "Studies demonstrate gains.", evidence_chain: "Need to impact." });
  await runStrategy();
  const rows = (await f.pg.query("select id from gf_strategy_jobs where application_id=$1 and result ? 'rejected_strategy'", [app.id])).rows;
  assert.equal(rows.length, 1);
  assert.equal((await svc.handle(f.ctx, { action: "strategy_rejection", application_id: app.id })).rejection.rejected_strategy.alignment_points, "Studies demonstrate gains.");
  // A successful job clears it.
  reply = null;
  const done = await runStrategy();
  assert.equal(done.job.status, "COMPLETED");
  await assert.rejects(svc.handle(f.ctx, { action: "strategy_rejection", application_id: app.id }), (e) => e.status === 404);
});

test("15. another organization cannot read rejected output", async () => {
  reply = () => ({ ...STRATEGY, alignment_points: REJECTED_TEXT, evidence_chain: "Need to impact." });
  const { job } = await runStrategy();
  assert.equal(job.status, "FAILED");
  assert.ok((await svc.handle(f.ctx, { action: "strategy_rejection", application_id: app.id })).rejection);
  await assert.rejects(svc.handle(f.otherCtx, { action: "strategy_rejection", application_id: app.id }), (e) => e.status === 404);
  // A non-member naming this workspace is refused by the database.
  await assert.rejects(svc.handle({ org_id: f.ORG, user_id: f.OUTSIDER, role: "OWNER" }, { action: "strategy_rejection", application_id: app.id }));
});
