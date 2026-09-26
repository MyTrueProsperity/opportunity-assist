"use strict";
// Any sentence that attributes a claim to research, evidence, studies,
// surveys, evaluations, literature, findings, data or analysis must cite a
// selected canonical record id in that sentence, and the cited record must
// actually report the claim.
//
// Production example (2026-09-26, revision 46): the evidence chain cited its
// records, but alignment_points said "research evidence supporting earnings
// and credential outcomes", "service-learning evidence showing benefits ...",
// "employer priorities documented in national surveys" with no ids, and the
// first of these overstated EM-039, which reports that credential attainment
// did not increase.
const test = require("node:test");
const assert = require("node:assert/strict");
const SQ = require("../netlify/lib/grant-factory/strategy-quantities");
const SE = require("../netlify/lib/grant-factory/strategy-evidence");
const SA = require("../netlify/lib/grant-factory/strategy-attribution");
const AI = require("../netlify/lib/grant-factory/ai");

const SECTIONS = ["primary_case", "funder_priorities", "alignment_points", "themes_to_emphasize", "themes_to_deemphasize", "likely_funding_use", "evidence_gaps", "evidence_chain", "budget_consistency"];
const STRATEGY = { primary_case: "Case", funder_priorities: "Priorities", alignment_points: "Points", themes_to_emphasize: "Themes", themes_to_deemphasize: "None", likely_funding_use: "Staff", evidence_gaps: "Gaps", evidence_chain: "Need to impact", budget_consistency: "No unfunded activities found" };
const PKG = "PKG_V1_2026-01-01";
const fact = (id, value) => ({ id, display_name: id, value, category: "Organization", verification_status: "APPROVED" });
const research = (record_id, r) => ({ id: "r-" + record_id, display_name: record_id + " · " + r.topic, value: r.approved_language || r.finding, research: { package_version: PKG, record_id, ...r }, selection: { rank: 1, reasons: ["planning aid"] } });

// EM-039 exactly as the production library holds it.
const EM039 = {
  topic: "Career academies and long-term earnings",
  finding: "Annual earnings averaged 11% higher over eight years, with gains concentrated among young men. Postsecondary credential attainment did not increase relative to controls.",
  supports: ["Integrated academic, technical and employer-linked learning can improve earnings."],
  does_not_support: ["The evaluated model is intensive and older; partial implementations cannot inherit its effect size. Do not claim that the study increased college completion."],
  prohibited_language: ["Do not present external research as a documented Bright Minds outcome or a guaranteed program effect."],
  population: "Students in nine U.S. high schools with career academies",
  source_org: "MDRC",
};
const REQUEST = {
  application: { funder_name: "County Workforce Fund", allowable_costs: "Staff and student wages up to $250,000 per year", reporting: "Grantees report enrollment data quarterly." },
  questions: [{ question_text: "Describe your program. Maximum 150 words." }],
  program: { name: "Youth Workforce Program" },
  facts: [
    fact("enrollment", "The Academy plans to enroll approximately 150 students."),
    fact("history", "Over ten years, Bright Minds served 700+ youth; Bright Minds alumni data show graduates in six career sectors."),
    research("EP-018", { topic: "Employer views of workforce readiness", finding: "84% of employers agree most high school students are not prepared to enter the workforce; 96% value financial literacy for career starters; 90% value communication.", supports: ["Employer interest in financial capability and demonstrated workplace skills."], source_org: "U.S. Chamber of Commerce" }),
    research("CB-007", { topic: "Service-learning meta-analysis", finding: "A meta-analysis of 62 studies involving 11,837 students found significant benefits across five outcome domains, with mean effects between 0.27 and 0.43.", supports: ["Well-designed service-learning can contribute to civic, social, academic and self-related development."], source_org: "Celio, Durlak and Dymnicki" }),
    research("CFSC-918", { topic: "Financial education effects", finding: "Financial education improved financial knowledge and behavior on average.", supports: ["Financial instruction can change measured behavior, not only knowledge."], source_org: "Kaiser, Lusardi, Menkhoff and Urban" }),
    research("EM-039", EM039),
  ],
};
const SELECTED = REQUEST.facts.filter((f) => f.research);
const BUNDLE = {
  records: [...SELECTED.map((f) => f.research), { package_version: PKG, record_id: "EM-051", finding: "44% of households are below the ALICE threshold." }],
  aliases: [{ package_version: PKG, legacy_record_id: "EM-OLD-39", canonical_record_id: "EM-039" }],
  rules: [{ package_version: PKG, rule_id: "CR-2", rule: "Use EM-051 for the newer county ALICE hardship series." }],
};
const CHAIN = "Need: 84% of employers agree most high school students are not prepared [EP-018]; supports employer demand, does not support local need.";
function validate(strategy) {
  const citations = SE.researchCitations(strategy, SELECTED, BUNDLE);
  const a = SQ.analyze(strategy, REQUEST, BUNDLE);
  return { invalid: citations.invalid, unsupported: a.unsupported, uncited: a.uncited, cited: a.cited };
}
const withSection = (section, text) => ({ ...STRATEGY, evidence_chain: CHAIN, [section]: section === "evidence_chain" ? CHAIN + " " + text : text });
const ok = (strategy) => { const v = validate(strategy); assert.deepEqual([v.invalid, v.unsupported, v.uncited], [[], [], []], JSON.stringify(v)); return v; };
const rejected = (strategy, re) => {
  const v = validate(strategy);
  const all = [...v.uncited, ...v.unsupported].map((u) => u.text + " | " + u.reason);
  assert.ok(v.invalid.length || all.length, "expected a rejection");
  if (re) assert.ok(all.some((x) => re.test(x)) || v.invalid.some((x) => re.test(x)), JSON.stringify(v));
  return v;
};

test("1-4. explicit research attributions without an id are rejected", () => {
  for (const [sentence, cue] of [
    ["Research evidence shows paid work builds professional skills.", /Research evidence shows/],
    ["Studies demonstrate that service-learning improves civic development.", /Studies demonstrate/],
    ["National surveys document employer demand for communication.", /surveys document/],
    ["Evidence indicates financial education changes behavior.", /Evidence indicates/],
    ["Research shows mentoring helps.", /Research shows/],
    ["Service-learning evidence shows benefits across civic and academic domains.", /evidence shows/],
    ["The literature suggests reflection matters.", /literature suggests/],
    ["Evaluation findings show dual enrollment helps.", /findings show/],
    ["Data indicate most students are not prepared for work.", /Data indicate/],
    ["Employer priorities are documented in national surveys.", /documented in national surveys/],
    ["According to the literature, mentoring helps.", /According to the literature/],
    ["Career academies are supported by rigorous research.", /supported by rigorous research/],
  ]) rejected(withSection("alignment_points", sentence), cue);
});

test("5. the same statements with a selected supporting canonical id are accepted", () => {
  ok(withSection("alignment_points", "Research evidence shows employers value communication and financial literacy [EP-018]."));
  ok(withSection("alignment_points", "Studies demonstrate that service-learning builds civic, social and academic development [CB-007]."));
  ok(withSection("alignment_points", "National surveys document employer demand for communication and financial literacy [EP-018]."));
  ok(withSection("alignment_points", "Evidence indicates financial education improves knowledge and behavior [CFSC-918]."));
  ok(withSection("alignment_points", "Research evidence supports earnings gains from integrated, employer-linked learning [EM-039]."));
  // Several claims, each with its own record, in one sentence.
  ok(withSection("alignment_points", "Research shows employers value communication [EP-018], service-learning builds civic development [CB-007], and financial education changes behavior [CFSC-918]."));
});

test("6. a selected id that does not report the claim is rejected", () => {
  rejected(withSection("alignment_points", "Research shows mentoring improves reading scores [EP-018]."), /does not report this claim/);
  rejected(withSection("alignment_points", "Studies demonstrate that financial education improves knowledge and behavior [CB-007]."), /does not report this claim/);
  rejected(withSection("alignment_points", "Evidence indicates career academies raise earnings [CFSC-918]."), /does not report this claim/);
  // A citation standing alone after a claim it does not support.
  rejected(withSection("evidence_chain", "Rural housing costs doubled [CB-007]."), /does not report this claim|does not contain/);
});

test("7. the EM-039 credential-attainment overstatement is rejected, not corrected", () => {
  // Cited: EM-039 reports that credential attainment did not increase.
  const cited = [
    "The Academy connects academic and applied learning through paid work, an approach with research evidence supporting earnings and credential outcomes when implemented as an integrated model [EM-039].",
    "Career academies improved credential attainment [EM-039].",
    "Research shows integrated models increase postsecondary credentials and earnings [EM-039].",
    "Integrated career academies increase college completion [EM-039].",
  ];
  for (const sentence of cited) {
    const v = rejected(withSection("alignment_points", sentence), /EM-039 reports no improvement/);
    assert.ok(v.uncited.every((u) => !/corrected/i.test(u.reason)));
  }
  // Derived from EM-039 without citing it (the production sentence).
  rejected(withSection("alignment_points", "The proposed Academy connects academic and applied learning through paid work, internships, and employer partnerships, an approach with research evidence supporting earnings and credential outcomes when implemented as an integrated model."), /research evidence supporting/);
  // Stating EM-039 accurately passes.
  ok(withSection("alignment_points", "Research shows career academies raised earnings 11% while credential attainment did not increase [EM-039]."));
  ok(withSection("alignment_points", "Integrated career academies raised earnings but not credential attainment [EM-039]."));
  // The strategy text is never rewritten: analysis only reports.
  const strategy = withSection("alignment_points", cited[1]);
  const before = JSON.stringify(strategy);
  SQ.analyze(strategy, REQUEST, BUNDLE);
  assert.equal(JSON.stringify(strategy), before);
});

test("8-9. organization, application and opportunity facts need no research citation", () => {
  ok({ ...STRATEGY, primary_case: "Bright Minds alumni data show graduates in six career sectors. Our program data show 700+ youth served over ten years." });
  ok({ ...STRATEGY, alignment_points: "The Academy plans approximately 150 students; Bright Minds served 700+ youth." });
  ok({ ...STRATEGY, funder_priorities: "The application states grantees report enrollment data quarterly. The funder's data show county priorities for youth employment." });
  ok({ ...STRATEGY, budget_consistency: "Established: wages allowable up to $250,000 per year.\nGaps: student wage rate not yet established." });
});

test("10. plans, recommendations, gaps, questions and instructions are not research claims", () => {
  for (const sentence of [
    "The Academy will collect data showing whether students gain credentials.",
    "Develop an evaluation that documents participant outcomes.",
    "Gaps: no outcome data shows program effects yet.",
    "Decisions and actions: commission research that documents local need; confirm evaluation findings with the funder.",
    "Is there evidence showing local need?",
    "Outcomes will be measured by an external evaluation.",
    "Do not generalize national research findings as Bright Minds outcomes.",
    "Research-informed design integrates mentoring and service.",
    "Evidence-based practices guide the model.",
    "Planned systematic evaluation with defined populations and measured outcomes.",
  ]) ok(withSection("evidence_gaps", sentence));
});

test("11. quantitative citation rules are intact", () => {
  rejected(withSection("themes_to_emphasize", "84% of employers agree most students are not prepared."), /84%/);
  rejected(withSection("themes_to_emphasize", "84% of employers agree most students are not prepared [CB-007]."), /does not contain this number/);
  rejected(withSection("alignment_points", "Service-learning effects of 0.27-0.43 [EP-018]."), /does not contain this value/);
  ok(withSection("alignment_points", "Service-learning effects of 0.27-0.43 [CB-007] support civic design."));
  const v = rejected({ ...STRATEGY, evidence_chain: CHAIN, budget_consistency: "Students earn $15/hour for 10 hours/week." }, /\$15\/hour/);
  assert.ok(v.unsupported.length);
});

test("12. evidence-chain and citation-allowlist rules are intact", () => {
  // Research used, but the evidence chain cites no record.
  const v = rejected({ ...STRATEGY, themes_to_emphasize: "96% value financial literacy [EP-018].", evidence_chain: "Need to program response to impact; no local outcome data yet." });
  assert.ok(v.uncited.some((u) => /evidence chain cites no selected record id/.test(u.reason)));
  // Unselected, alias and rule-only ids are invalid citations.
  assert.deepEqual(validate(withSection("evidence_chain", "Hardship: 44% of households are below ALICE [EM-051].")).invalid, ["EM-051"]);
  assert.deepEqual(validate(withSection("alignment_points", "Research shows earnings rose 11% [EM-OLD-39].")).invalid, ["EM-OLD-39"]);
  // Selected but unused records need not be cited.
  assert.deepEqual(ok({ ...STRATEGY, evidence_chain: CHAIN }).cited, ["EP-018"]);
});

test("13. all nine sections are validated", () => {
  for (const section of SECTIONS) {
    const a = validate(withSection(section, "National surveys document employer demand for communication."));
    assert.ok(a.uncited.some((u) => u.section === section && /surveys document/.test(u.reason)), section + " attribution: " + JSON.stringify(a.uncited));
    const b = validate(withSection(section, "Career academies improved credential attainment [EM-039]."));
    assert.ok(b.uncited.some((u) => u.section === section && /EM-039 reports no improvement/.test(u.reason)), section + " support: " + JSON.stringify(b.uncited));
  }
});

test("the detector is bounded and explains itself", () => {
  assert.equal(SA.attribution("Students complete a portfolio and a Graduate Defense."), null);
  assert.equal(SA.attribution("Enrollment data are collected each term."), null);
  assert.match(SA.attribution("Multiple randomized evaluations consistently demonstrate gains."), /evaluations consistently demonstrate/);
  assert.deepEqual(SA.deniedOutcomes(EM039).map((d) => d.phrase), ["Postsecondary credential attainment", "college completion"]);
});

test("the prompt adds one concise attribution instruction", () => {
  const p = AI.systemPrompt("strategy");
  assert.match(p, /Every sentence that attributes a finding to research, studies, surveys, evidence or similar sources needs that record_id in the same sentence/);
  assert.ok(p.length < 4450, "prompt length " + p.length);
});

test("14. production-sized validation stays well under one second with every check running", () => {
  const w = (n, k) => Array.from({ length: n }, (_, i) => ["youth", "workforce", "county", "households", "employment", "program", "evidence", "outcomes", "survey", "region"][(i + k) % 10]).join(" ");
  const facts = [];
  for (let i = 0; i < 200; i++) facts.push({ ...fact("f" + i, w(60, i) + " served " + (100 + i) + " students from 2016–2026 in grades 9–12, budget $" + (1000 * i) + " and " + (i % 50) + "% match"), notes: w(40, i) });
  for (let r = 0; r < 24; r++) {
    const parts = [];
    for (let k = 0; k < 40; k++) parts.push(w(12, k + r) + " rates rose " + (10 + k) + "% to " + (20 + k) + "% between 2016–2024, effects 0.2" + k + "–0.4" + k + ", ages 14–18, $" + (5 + k) + "k–$" + (9 + k) + "k per year, " + (3 + k) + "–" + (6 + k) + " hours/week");
    parts.push("Credential attainment did not increase relative to controls");
    facts.push(research("RX-" + String(r).padStart(3, "0"), { topic: w(4, r), finding: parts.join(". "), supports: [w(12, r)], does_not_support: ["Do not claim that the study increased college completion."], source_org: "Example Institute " + r }));
  }
  const lines = [];
  for (let i = 0; i < 160; i++) lines.push("Point " + i + ": research shows " + w(10, i) + " rose " + (10 + (i % 40)) + "% [RX-" + String(i % 24).padStart(3, "0") + "] across 2016–2026, and survey evidence indicates " + w(6, i + 3) + " [RX-" + String((i + 1) % 24).padStart(3, "0") + "].");
  const text = lines.join(" ");
  const strategy = { ...STRATEGY, primary_case: text.slice(0, 3000), alignment_points: text.slice(3000, 6000), themes_to_emphasize: text.slice(6000, 9000), evidence_gaps: text.slice(9000, 13000), evidence_chain: text.slice(13000, 24000) };
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
  // Planted problems are still caught at this size.
  const planted = SQ.analyze({ ...strategy, budget_consistency: "Studies demonstrate gains in youth employment. Programs raised college completion [RX-003]." }, request, bundle);
  assert.ok(planted.uncited.some((u) => /Studies demonstrate/.test(u.reason)), JSON.stringify(planted.uncited.slice(0, 5)));
  assert.ok(planted.uncited.some((u) => /RX-003 reports no improvement in college completion/.test(u.reason)), JSON.stringify(planted.uncited.slice(0, 5)));
});
