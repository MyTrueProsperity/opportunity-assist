"use strict";
// The three failures in the PR #33 first-run production validation
// (2026-09-26, job 733d52df):
//   - "... 17% of U.S. assessed youth scored below baseline proficiency;
//     Florida statute requires ... [CFSC-942, CFSC-937]" was rejected because a
//     semicolon ended the sentence before its citation (false positive);
//   - "Historical research supports ..." with no id was accepted because
//     "historical" marked the organization's own data (false negative);
//   - "External research supports ..." in evidence_gaps had no id (correct
//     rejection; the output format now asks for the id in that section).
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

// As the production library holds them.
const CFSC942 = { topic: "Youth financial literacy proficiency", finding: "An estimated 17% of US students were below baseline Level 2 financial-literacy proficiency.", supports: ["National financial-literacy need among assessed youth."], source_org: "OECD PISA" };
const CFSC937 = { topic: "Florida financial literacy graduation requirement", finding: "The requirement includes one-half credit in personal financial literacy and money management for the specified entering cohorts.", supports: ["Florida state policy context for financial literacy instruction."], source_org: "Florida Legislature" };
const CTE004 = { topic: "P-TECH dual enrollment", finding: "By the end of four years, 46% of P-TECH students had dual-enrolled in college compared with 20% of comparison students.", supports: ["Supports purposeful dual enrollment embedded inside an integrated career pathway."], source_org: "MDRC" };
const EM039 = { topic: "Career academies and long-term earnings", finding: "Annual earnings averaged 11% higher over eight years. Postsecondary credential attainment did not increase relative to controls.", supports: ["Integrated academic, technical and employer-linked learning can improve earnings."], does_not_support: ["Do not claim that the study increased college completion."], source_org: "MDRC" };
const CB007 = { topic: "Service-learning meta-analysis", finding: "A meta-analysis of 62 studies found significant benefits across five outcome domains, with mean effects between 0.27 and 0.43.", supports: ["Well-designed service-learning can contribute to civic, social, academic and self-related development."] };
const CFSC918 = { topic: "Financial education effects", finding: "Financial education improved financial knowledge and behavior on average.", supports: ["Financial instruction can change measured behavior, not only knowledge."] };

const REQUEST = {
  application: { funder_name: "County Workforce Fund" },
  questions: [{ question_text: "Describe your program." }],
  program: { name: "Bright Minds Professional Academy" },
  facts: [
    fact("history", "Historical Bright Minds programming operated 2016-2026 with 123+ documented alumni outcomes and 274 participants documented across seven formal cohorts (2018-2025). Internal tracking was not comprehensive in every cohort year."),
    research("CFSC-942", CFSC942), research("CFSC-937", CFSC937), research("CTE_RESEARCH_004", CTE004), research("EM-039", EM039), research("CB-007", CB007), research("CFSC-918", CFSC918),
  ],
};
const SELECTED = REQUEST.facts.filter((f) => f.research);
const BUNDLE = { records: [...SELECTED.map((f) => f.research), { package_version: PKG, record_id: "EM-051", finding: "44% of households are below the ALICE threshold." }], aliases: [{ package_version: PKG, legacy_record_id: "CFSC-OLD-942", canonical_record_id: "CFSC-942" }] };
const CHAIN = "Need: Florida requires one-half credit in personal financial literacy [CFSC-937].";
const withSection = (section, text) => ({ ...STRATEGY, evidence_chain: CHAIN, [section]: section === "evidence_chain" ? CHAIN + " " + text : text });
function validate(strategy) {
  const citations = SE.researchCitations(strategy, SELECTED, BUNDLE);
  const a = SQ.analyze(strategy, REQUEST, BUNDLE);
  return { invalid: citations.invalid, unsupported: a.unsupported, uncited: a.uncited, cited: a.cited };
}
const ok = (strategy) => { const v = validate(strategy); assert.deepEqual([v.invalid, v.unsupported, v.uncited], [[], [], []], JSON.stringify(v)); return v; };
const rejected = (strategy, re) => {
  const v = validate(strategy);
  const all = [...v.uncited, ...v.unsupported].map((u) => u.text + " | " + u.reason);
  assert.ok(v.invalid.length || all.length, "expected a rejection");
  if (re) assert.ok(all.some((x) => re.test(x)) || v.invalid.some((x) => re.test(x)), JSON.stringify(v));
  return v;
};

// The exact production sentence.
const SEMICOLON = "National financial-literacy assessment shows 17% of U.S. assessed youth scored below baseline proficiency; Florida statute requires one-half credit in personal financial literacy [CFSC-942, CFSC-937].";

test("a semicolon-joined research number is satisfied by the sentence's citation of the record that supports it", () => {
  ok(withSection("evidence_chain", SEMICOLON));
  ok(withSection("alignment_points", SEMICOLON));
});

test("the same sentence without CFSC-942 is rejected", () => {
  rejected(withSection("evidence_chain", SEMICOLON.replace("CFSC-942, ", "")), /17%/);
  // Nor does a record that does not contain the number stand in for it.
  rejected(withSection("evidence_chain", SEMICOLON.replace("CFSC-942", "CB-007")), /17%/);
});

test("a semicolon never borrows a citation from another sentence", () => {
  rejected(withSection("evidence_chain", "National financial-literacy assessment shows 17% of U.S. assessed youth scored below baseline proficiency. Florida statute requires one-half credit in personal financial literacy [CFSC-942, CFSC-937]."), /17%/);
  rejected(withSection("alignment_points", "External research supports integrated learning as a design choice; Bright Minds operated 2016-2026. Service-learning builds civic development [CB-007]."), /research supports/);
  // Within one sentence, a clause borrows only the next citation, and the
  // research claim must be one that citation's record reports.
  rejected(withSection("alignment_points", "Research shows mentoring improves reading scores; Florida statute requires one-half credit in personal financial literacy [CFSC-937]."), /does not report this claim/);
});

test("Historical research supports ... without a selected id is rejected; with its supporting id it is accepted", () => {
  // The exact production sentence (alignment_points).
  const sentence = "Historical research supports integrated academic-technical learning (Career Academies, P-TECH dual enrollment), reflective service-learning, mentoring, financial education, entrepreneurship education and media literacy as evidence-informed design features.";
  rejected(withSection("alignment_points", sentence), /research supports/);
  ok(withSection("alignment_points", "Historical research supports integrated academic-technical learning with employer-linked earnings gains [EM-039] and embedded dual enrollment [CTE_RESEARCH_004]."));
});

test("External research supports ... in evidence_gaps without an id is rejected; the cited equivalent is accepted", () => {
  // The exact production sentence.
  rejected(withSection("evidence_gaps", "**Established:** Historical Bright Minds programming operated 2016–2026 with 123+ documented alumni outcomes. External research supports integrated academic-technical learning, reflective service, mentoring, financial education and media literacy as evidence-informed design choices."), /External research supports/);
  ok(withSection("evidence_gaps", "**Established:** External research supports service-learning for civic, social and academic development [CB-007] and financial education for knowledge and behavior [CFSC-918]."));
});

test("genuine organization historical and internal-data statements are not research", () => {
  for (const sentence of [
    "Historical program data show 274 participants documented across seven formal cohorts (2018-2025).",
    "Our alumni data show 123+ documented alumni outcomes.",
    "Internal tracking data indicate 123+ documented alumni outcomes.",
    "The organization's historical records document 123+ alumni outcomes.",
    "Internal reporting was not comprehensive in every cohort year.",
    "Bright Minds data show 123+ documented alumni outcomes.",
  ]) ok(withSection("primary_case", sentence));
  // Explicit external-evidence nouns always count, whatever the qualifier.
  for (const sentence of ["Historical studies demonstrate gains.", "Our literature review shows gains.", "Internal evaluations show gains.", "Empirical findings show gains.", "Historical evidence indicates gains.", "Past surveys document gains."])
    assert.ok(SA.attribution(sentence), sentence);
});

test("the exact Bright Minds historical-evidence sentence (funder_priorities) is a description of the question, not a research claim", () => {
  ok(withSection("funder_priorities", "The application questions require: (1) a description of planned programs clearly identifying future activities; and (2) an explanation of what historical Bright Minds evidence supports, without confusing documented alumni outcomes with total students served or success rates."));
  // The distinction Bill drew.
  ok(withSection("funder_priorities", "What historical Bright Minds evidence supports this approach?"));
  rejected(withSection("funder_priorities", "National research evidence supports this approach."), /research evidence supports/);
});

test("describing what an application, funder question or prompt asks for is not a research claim", () => {
  for (const sentence of [
    "The funder question asks what evidence supports the model.",
    "Question 2 asks applicants to explain what research shows about their approach.",
    "Provide a description of how the data show participant outcomes.",
    "Clarify what historical data demonstrate about participant outcomes.",
    "The prompt requests a statement of which studies support the design.",
  ]) ok(withSection("funder_priorities", sentence));
  // The same words asserted as findings still need a selected record.
  rejected(withSection("funder_priorities", "The application asks what evidence supports this design; national research demonstrates that mentoring improves outcomes."), /research demonstrates/);
  rejected(withSection("alignment_points", "What research shows is that mentoring improves outcomes."), /research shows/);
});

test("the Institute's own evidence, records and documentation are not external research; external evidence still is", () => {
  for (const sentence of [
    "The Institute's own evidence supports an applied-learning model.",
    "Our evidence supports the integrated design.",
    "Internal evidence supports continued alumni engagement.",
    "Bright Minds evidence supports professional communication gains among alumni.",
    "The organization's documentation shows 123+ alumni outcomes.",
    "Bright Minds records document alumni across many colleges and sectors.",
  ]) ok(withSection("primary_case", sentence));
  for (const sentence of [
    "Historical evidence indicates gains in earnings.",
    "Research evidence supports the integrated design.",
    "National research evidence supports this approach.",
    "External evidence supports mentoring.",
    "Survey evidence documents employer priorities.",
    "Studies demonstrate gains in youth employment.",
    "Internal evaluations show gains.",
  ]) assert.ok(SA.attribution(sentence, "institute of bright minds bright minds"), sentence);
  rejected(withSection("alignment_points", "National research supports the program's integrated approach."), /research supports/);
  rejected(withSection("evidence_chain", "National employer priorities and research rationales support the program's design priorities but do not establish local gaps."), /research rationales support/);
});

test("existing controls are intact", () => {
  // Selected-evidence allowlist and canonical ids.
  assert.deepEqual(validate(withSection("evidence_chain", "Hardship: 44% of households are below ALICE [EM-051].")).invalid, ["EM-051"]);
  assert.deepEqual(validate(withSection("evidence_chain", "17% scored below baseline proficiency [CFSC-OLD-942].")).invalid, ["CFSC-OLD-942"]);
  // Substantive support and the EM-039 regression.
  rejected(withSection("alignment_points", "Career academies improved credential attainment [EM-039]."), /EM-039 reports no improvement/);
  // Same-sentence research numbers.
  rejected(withSection("themes_to_emphasize", "46% of students dual-enrolled in college."), /46%/);
  // Applicant quantitative grounding.
  rejected(withSection("budget_consistency", "Students earn $15/hour for 10 hours/week."), /\$15\/hour/);
  // Gap wording and scholarship.
  ok(withSection("evidence_gaps", "Gaps: local prevalence is not documented in supplied evidence; scholarship funding sources and estimated amounts are not specified."));
  // Organization-fact grounding.
  ok(withSection("primary_case", "Bright Minds documented 274 participants across seven formal cohorts."));
  // Every section is checked.
  for (const section of SECTIONS) {
    const v = validate(withSection(section, "Historical research supports integrated learning."));
    assert.ok(v.uncited.some((u) => u.section === section), section);
  }
});

test("the output format asks for the record id in evidence_gaps and alignment_points, concisely", () => {
  const props = AI.schemas.strategy.properties;
  for (const k of ["evidence_gaps", "alignment_points"]) {
    assert.match(props[k].description, /research, evidence, studies, surveys, literature or evaluation findings support a point, put the supporting record_id in that sentence; otherwise omit the attribution/);
    assert.ok(props[k].description.length < 220, k);
  }
  assert.ok(AI.requestChars("strategy", null) < 5700, "request overhead " + AI.requestChars("strategy", null));
});

test("production-sized validation stays well under one second", () => {
  const w = (n, k) => Array.from({ length: n }, (_, i) => ["youth", "workforce", "county", "households", "employment", "program", "evidence", "outcomes", "survey", "region"][(i + k) % 10]).join(" ");
  const facts = [REQUEST.facts[0]];
  for (let i = 0; i < 200; i++) facts.push({ ...fact("f" + i, w(60, i) + " served " + (100 + i) + " students from 2016–2026 in grades 9–12, budget $" + (1000 * i) + " and " + (i % 50) + "% match"), notes: w(40, i) });
  for (let r = 0; r < 24; r++) {
    const parts = [];
    for (let k = 0; k < 40; k++) parts.push(w(12, k + r) + " rates rose " + (10 + k) + "% to " + (20 + k) + "% between 2016–2024, effects 0.2" + k + "–0.4" + k + ", ages 14–18, $" + (5 + k) + "k–$" + (9 + k) + "k per year, " + (3 + k) + "–" + (6 + k) + " hours/week");
    facts.push(research("RX-" + String(r).padStart(3, "0"), { topic: w(4, r), finding: parts.join(". "), supports: [w(12, r)] }));
  }
  const lines = [];
  for (let i = 0; i < 160; i++) lines.push("Point " + i + ": historical research shows " + w(10, i) + " rose " + (10 + (i % 40)) + "%; " + w(6, i + 2) + " also improved [RX-" + String(i % 24).padStart(3, "0") + "], while county outcome data are not documented in supplied evidence.");
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
  const planted = SQ.analyze({ ...strategy, budget_consistency: "Students earn $15/hour. Historical research supports gains in youth employment." }, request, bundle);
  assert.ok(planted.unsupported.some((u) => u.text === "$15/hour"));
  assert.ok(planted.uncited.some((u) => /research supports/.test(u.reason)));
});
