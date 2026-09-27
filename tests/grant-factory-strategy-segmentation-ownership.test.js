"use strict";
// Step 1 of the validator consolidation (see docs/research-evidence-retrieval.md,
// "Sentences, clauses and citation ownership"): shared segmentation, citation
// ownership and the calculation guard. Each test below is a production false
// positive from PRs #29 to #36 in sanitized form, paired with the rejection
// the same rule must keep making. The measured effect of the changes on the
// labeled corpora is in tests/validator-eval (guard test: tests/validator-eval.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const SQ = require("../netlify/lib/grant-factory/strategy-quantities");
const SE = require("../netlify/lib/grant-factory/strategy-evidence");
const SA = require("../netlify/lib/grant-factory/strategy-attribution");

const STRATEGY = { primary_case: "Case", funder_priorities: "Priorities", alignment_points: "Points", themes_to_emphasize: "Themes", themes_to_deemphasize: "None", likely_funding_use: "Staff", evidence_gaps: "Gaps", evidence_chain: "Need to impact", budget_consistency: "No unfunded activities found" };
const PKG = "PKG_V1_2026-01-01";
const fact = (id, value) => ({ id, display_name: id, value, category: "Organization", verification_status: "APPROVED" });
const research = (record_id, r) => ({ id: "r-" + record_id, display_name: record_id + " · " + r.topic, value: r.approved_language || r.finding, research: { package_version: PKG, record_id, ...r }, selection: { rank: 1, reasons: ["planning aid"] } });

const CFSC942 = { topic: "Youth financial literacy proficiency", finding: "An estimated 17% of US students were below baseline Level 2 financial-literacy proficiency.", supports: ["National financial-literacy need among assessed youth."], source_org: "OECD PISA" };
const CFSC937 = { topic: "Florida financial literacy graduation requirement", finding: "The requirement includes one-half credit in personal financial literacy and money management for the specified entering cohorts.", supports: ["Florida state policy context for financial literacy instruction."], source_org: "Florida Legislature" };
const EM039 = { topic: "Career academies and long-term earnings", finding: "Annual earnings averaged 11% higher over eight years. Postsecondary credential attainment did not increase relative to controls.", supports: ["Integrated academic, technical and employer-linked learning can improve earnings."], does_not_support: ["Do not claim that the study increased college completion."], source_org: "MDRC" };
const CB007 = { topic: "Service-learning meta-analysis", finding: "A meta-analysis of 62 studies found significant benefits across five outcome domains, with mean effects between 0.27 and 0.43.", supports: ["Well-designed service-learning can contribute to civic, social, academic and self-related development."] };
const CFSC918 = { topic: "Financial education effects", finding: "Financial education improved financial knowledge and behavior on average.", supports: ["Financial instruction can change measured behavior, not only knowledge."] };
const YM001 = { topic: "Youth mentoring meta-analysis", finding: "Mentoring produced statistically significant, generally modest average improvements across youth outcomes.", supports: ["Caring-adult relationships can contribute to development when delivered through organized programs."], sample_size: "70 studies; 25,000 young people", source_org: "Journal of Youth Studies", source_authors: "Raposa, E. B., et al." };
const EP017 = { topic: "Career readiness competency framework", finding: "Communication, critical thinking, professionalism, teamwork and career self-development are separate competencies illustrated through observable behaviors.", supports: ["A common vocabulary for expectations and assessment."], source_org: "National Association of Colleges and Employers" };

const REQUEST = {
  application: { funder_name: "County Workforce Fund" },
  questions: [{ question_text: "Describe your program." }],
  program: { name: "Bright Minds Professional Academy" },
  facts: [
    fact("history", "Historical Bright Minds programming operated 2016-2026 with 123+ documented alumni outcomes and 274 participants documented across seven formal cohorts (2018-2025)."),
    fact("enrollment", "Approximately 160 students in grades 9 through 11 at launch."),
    research("CFSC-942", CFSC942), research("CFSC-937", CFSC937), research("EM-039", EM039), research("CB-007", CB007), research("CFSC-918", CFSC918), research("YM-001", YM001), research("EP-017", EP017),
  ],
};
const SELECTED = REQUEST.facts.filter((f) => f.research);
const BUNDLE = { records: [...SELECTED.map((f) => f.research), { package_version: PKG, record_id: "EM-051", finding: "44% of households are below the ALICE threshold." }], aliases: [] };
const CHAIN = "Need: Florida requires one-half credit in personal financial literacy [CFSC-937].";
const withSection = (section, text) => ({ ...STRATEGY, evidence_chain: CHAIN, [section]: section === "evidence_chain" ? CHAIN + " " + text : text });
function validate(strategy) {
  const citations = SE.researchCitations(strategy, SELECTED, BUNDLE);
  const a = SQ.analyze(strategy, REQUEST, BUNDLE);
  return { invalid: citations.invalid, unsupported: a.unsupported, uncited: a.uncited };
}
const ok = (strategy) => { const v = validate(strategy); assert.deepEqual([v.invalid, v.unsupported, v.uncited], [[], [], []], JSON.stringify(v)); };
const rejected = (strategy, re) => {
  const v = validate(strategy);
  const all = [...v.uncited, ...v.unsupported].map((u) => u.text + " | " + u.reason);
  assert.ok(v.invalid.length || all.length, "expected a rejection: " + JSON.stringify(strategy));
  if (re) assert.ok(all.some((x) => re.test(x)) || v.invalid.some((x) => re.test(x)), JSON.stringify(v));
};

// ---- segmentation -----------------------------------------------------------

test("bold markup closing a sentence ends it: a gap statement is not merged with the cited sentence after it", () => {
  // Production false positive (PR #36): the merged text failed the subject check of the citation after it.
  ok(withSection("evidence_gaps", "**Missing: county job-market research for each pathway (occupations, demand, wages, entry requirements).** Service-learning meta-analysis (CB-007) supports civic, social and academic development."));
  // The gap statement still cannot lend its plan wording to a research claim in the next sentence.
  rejected(withSection("evidence_gaps", "**Missing: county job-market research.** National research shows that mentoring improves reading scores."), /research shows/);
});

test("an opening quotation mark starts a sentence: a research claim after a flag that begins with 'No' is still a claim", () => {
  // Production false negative: PLAN_START matched "No coordinator identified" and exempted the whole merged text.
  rejected(withSection("budget_consistency", "**Flag**: No coordinator identified. \"Every student leads at least one initiative\" implies significant staff time for project oversight, reflection facilitation (research shows reflection critical to outcomes), and documentation."), /research shows/);
  ok(withSection("budget_consistency", "**Flag**: No coordinator identified. \"Every student leads a capstone initiative\" implies significant staff time for project oversight and documentation. Reflection amplified service-learning effects across five outcome domains [CB-007]."));
});

test("a semicolon clause with no citation borrows the next citation in its sentence, else the one before it", () => {
  // Production false positive (PR #36): "; Raposa 2019)" became a clause that could not borrow the citation before it.
  ok(withSection("evidence_chain", "Mentoring average effects on youth outcomes (YM-001: meta-analysis, 70 studies, 25,000 youth; modest average improvements; strongest when one-to-one and consistent; Raposa 2019)."));
  // A named source in a sentence with no citation at all is still uncited.
  rejected(withSection("evidence_chain", "Mentoring produces modest average improvements; Raposa 2019 reports this for one-to-one programs."), /Raposa/);
  // Borrowing never crosses a sentence boundary, and the borrowed record must report the claim.
  rejected(withSection("evidence_chain", "Mentoring produces modest average improvements [YM-001]. Financial education improves knowledge and behavior; Raposa 2019."), /Raposa/);
  rejected(withSection("alignment_points", "Research shows mentoring improves reading scores; Florida statute requires one-half credit in personal financial literacy [CFSC-937]."), /does not report this claim/);
});

// ---- citation ownership -----------------------------------------------------

test("a heading before the first citation is not a claim", () => {
  ok(withSection("budget_consistency", "- Relevant research: YM-001 mentoring and CB-007 service work show value of structured engagement, but neither funds wages."));
  ok(withSection("evidence_chain", "**Research base**: Career readiness competency framework (EP-017: communication, critical thinking, professionalism, teamwork, career self-development, with observable behavior examples)."));
  ok(withSection("evidence_gaps", "**The youth center and belonging**: YM-001 (70-study mentoring synthesis) found modest average improvements across youth outcomes."));
});

test("citation-first: the claim is the text after the id, and it must be one the record reports", () => {
  ok(withSection("evidence_chain", "CFSC-942: 17% of US students were below baseline financial-literacy proficiency."));
  ok(withSection("evidence_chain", "[YM-001] reports modest average improvements across youth outcomes from mentoring."));
  rejected(withSection("evidence_chain", "CFSC-942: mentoring improves reading scores."), /does not report this claim/);
  rejected(withSection("evidence_chain", "CFSC-942: 44% of households are below the ALICE threshold."), /44%/);
});

test("text between two citations passes when either record reports it; a claim neither reports is still rejected", () => {
  // Production false positive (PR #36): "and national research [B]" took the text after it as its own claim.
  ok(withSection("funder_priorities", "Financial capability (state policy context [CFSC-937] and national research [CFSC-918]) and service learning with structured reflection [CB-007]."));
  rejected(withSection("funder_priorities", "Financial capability (state policy context [CFSC-937] and national research [CFSC-918]) and arts access raising household income [CB-007]."), /not report this claim/);
});

test("a label with subject words of its own is still checked against its record", () => {
  // The exact production shape (PR #30 era): a right record under a wrong label stays rejected.
  rejected(withSection("evidence_chain", "Dual-enrollment policy (CFSC-937: Florida requirement creates alignment opportunity, but a mandate is not evidence of delivery quality or mastery)."), /does not report this claim/);
  ok(withSection("evidence_chain", "Financial literacy graduation requirement (CFSC-937: Florida requirement creates alignment opportunity, but a mandate is not evidence of delivery quality or mastery)."));
});

test("the safety-critical rejections are unchanged", () => {
  rejected(withSection("evidence_chain", "County ALICE households: 44% [EM-051]."), /EM-051/);
  rejected(withSection("alignment_points", "Research shows mentoring improves reading scores [CFSC-942]."), /does not report this claim/);
  rejected(withSection("evidence_chain", "Employers agreed 17% of students were below baseline proficiency [CB-007]."), /17%/);
  rejected(withSection("evidence_chain", "The county graduated 93.1% of its 2024-25 cohort."), /93\.1%/);
  rejected(withSection("alignment_points", "Career academies improved credential attainment [EM-039]."), /reports no improvement/);
  rejected(withSection("budget_consistency", "Students earn $15/hour for 10 hours/week."), /\$15/);
});

// ---- calculation guard --------------------------------------------------------

test("a single-letter statistic before '=' is not a calculation; a calculation still is", () => {
  // Production false positive (PR #36): "n=47 studies" was read as a calculation with unsupported inputs.
  ok(withSection("evidence_chain", "Service learning with facilitation and reflection (CB-007: mean effects between 0.27 and 0.43; n=62 studies)."));
  ok(withSection("evidence_chain", "Service learning effects were positive (d = 0.27 to 0.43) across 62 studies [CB-007]."));
  rejected(withSection("budget_consistency", "If 160 students × 10 hours/week × $15/hour × 36 weeks = $864,000 annually, the wage line is significant."), /calculat|\$15/);
});

test("claims() charges each claim to the records the sentence attaches it to", () => {
  const isSelected = (t) => ["A-1", "B-2", "C-3"].includes(t);
  assert.deepEqual(SA.claims("Relevant research: A-1 shows mentoring gains.", isSelected), [{ ids: ["A-1"], text: "shows mentoring gains.", after: true }]);
  assert.deepEqual(SA.claims("Mentoring gains [A-1] and national research [B-2] and service learning [C-3].", isSelected), [
    { ids: ["A-1", "B-2"], text: "Mentoring gains [", after: false },
    { ids: ["B-2", "C-3"], text: "] and service learning [", after: false },
  ]);
  assert.deepEqual(SA.claims("Dual-enrollment policy (A-1: content of the record).", isSelected), [{ ids: ["A-1"], text: "Dual-enrollment policy (", after: false }]);
});
