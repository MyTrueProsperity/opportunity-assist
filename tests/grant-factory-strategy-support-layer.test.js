"use strict";
// Step 1.5 of the validator consolidation (see docs/research-evidence-retrieval.md,
// "Substantive support and labels"): the support scorer, content ownership for
// "Label (ID: content)", the separate label rule, list ownership across a
// parenthetical citation list, source acronyms, and the retry feedback for a
// misleading label. Each case is a production shape or a constructed case from
// the Step 1.5 evaluation (tests/validator-eval), paired with the rejection the
// same rule must keep making. The measured effect on the labeled corpora is in
// the guard test, tests/validator-eval.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const SQ = require("../netlify/lib/grant-factory/strategy-quantities");
const SE = require("../netlify/lib/grant-factory/strategy-evidence");
const SA = require("../netlify/lib/grant-factory/strategy-attribution");
const { validationFeedback } = require("../netlify/lib/grant-factory/service");

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
const CTE004 = { topic: "Pathway dual enrollment", finding: "By the end of four years, 41% of pathway students had dual-enrolled in college compared with 19% of comparison students.", supports: ["Purposeful dual enrollment embedded inside an integrated career pathway."], source_org: "MDRC" };
const EP017 = { topic: "Career readiness competency framework", finding: "Communication, critical thinking, professionalism, teamwork and career self-development are separate competencies illustrated through observable behaviors.", supports: ["A common vocabulary for expectations and assessment."], source_org: "National Association of Colleges and Employers" };

const REQUEST = {
  application: { funder_name: "County Workforce Fund" },
  questions: [{ question_text: "Describe your program." }],
  program: { name: "Bright Minds Professional Academy" },
  facts: [
    fact("history", "Historical Bright Minds programming operated 2016-2026 with 123+ documented alumni outcomes and 274 participants documented across seven formal cohorts (2018-2025)."),
    fact("enrollment", "Approximately 160 students in grades 9 through 11 at launch."),
    research("CFSC-942", CFSC942), research("CFSC-937", CFSC937), research("EM-039", EM039), research("CB-007", CB007), research("CFSC-918", CFSC918), research("YM-001", YM001), research("EP-017", EP017), research("CTE-004", CTE004),
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

// ---- the support scorer ---------------------------------------------------------

test("one distinctive whole-word term supports a claim; a six-character stem collision does not", () => {
  // "teamwork" is a whole word of EP-017 found in no other selected record.
  ok(withSection("evidence_chain", "Teamwork rose among younger participants [EP-017]."));
  // "reading" shares the stem "readin" with EP-017's "readiness" and nothing else.
  rejected(withSection("evidence_chain", "Reading fluency rose among younger participants [EP-017]."), /does not report this claim \(1 of 4 subject terms match, none distinctive\)/);
  rejected(withSection("evidence_chain", "Financial capability rose among younger participants [EP-017]."), /does not report this claim/);
  // Two shared terms of any kind still pass; a very short claim needs one.
  ok(withSection("evidence_chain", "Career readiness competencies rose among younger participants [EP-017]."));
  ok(withSection("alignment_points", "Employers value demonstrated teamwork [EP-017]."));
});

// ---- "Label (ID: content)": content ownership -----------------------------------

test("the content after the colon is the substantive claim, judged on its own", () => {
  ok(withSection("evidence_chain", "Youth mentoring (YM-001: mentoring produced modest average improvements across youth outcomes)."));
  rejected(withSection("evidence_chain", "Youth mentoring (YM-001: arts access raises household income)."), /does not report this claim \(0 of 4 subject terms match/);
  // Content that is little more than a figure is judged together with its label.
  ok(withSection("evidence_chain", "Career academies (EM-039: annual earnings averaged 11% higher over eight years; credential attainment did not increase)."));
  // A number in the content must still be the cited record's.
  rejected(withSection("evidence_chain", "Youth mentoring (YM-001: 44% of households are below the ALICE threshold)."), /44%/);
});

// ---- the label rule ---------------------------------------------------------------

test("a label that describes a different selected record is rejected, with the record it describes", () => {
  // The exact production shape (PR #30 era): the right record under a dual-enrollment label.
  rejected(withSection("evidence_chain", "Dual-enrollment policy (CFSC-937: Florida requirement creates alignment opportunity, but a mandate is not evidence of delivery quality or mastery)."), /does not report this label \(1 of 3 subject terms match\); the label describes CTE-004 \(dual, enroll\)/);
  // A one-term label is judged too.
  rejected(withSection("evidence_chain", "Mentoring (CFSC-937: one-half credit in personal financial literacy and money management for entering cohorts)."), /does not report this label \(0 of 1 subject terms match\); the label describes YM-001 \(mentor\)/);
  rejected(withSection("evidence_chain", "Mentoring outcomes (CTE-004: 41% of pathway students had dual-enrolled in college)."), /not report this label/);
  // The right label passes; so does the same label over the right record.
  ok(withSection("evidence_chain", "Financial literacy graduation requirement (CFSC-937: Florida requirement creates alignment opportunity, but a mandate is not evidence of delivery quality or mastery)."));
  ok(withSection("evidence_chain", "Youth mentoring (YM-001: mentoring produced modest average improvements across youth outcomes)."));
});

test("a match made only of common terms must cover more than half of the label", () => {
  // "education" is in most selected records; "financial" is CFSC-918's, not EM-039's.
  rejected(withSection("evidence_chain", "Financial education outcomes (EM-039: annual earnings averaged 11% higher over eight years)."), /does not report this label \(0 of 2 subject terms match\); the label describes CFSC-918/);
  // Both of the label's terms in the record: passes.
  ok(withSection("evidence_chain", "Career education outcomes (CFSC-918: financial education improved financial knowledge and behavior on average)."));
});

test("an imprecise or generic label that describes no other selected record passes", () => {
  ok(withSection("evidence_chain", "State policy context (CFSC-937: one-half credit in personal financial literacy for the specified entering cohorts)."));
  ok(withSection("evidence_chain", "Program design implications (CB-007: mean effects between 0.27 and 0.43 across five outcome domains)."));
  // The production shape of PR #36: a one-term label with no subject words of its own.
  ok(withSection("evidence_chain", "National context exists (CFSC-942: 17% of US students below baseline financial-literacy proficiency)."));
  ok(withSection("evidence_gaps", "**The youth center and belonging**: YM-001 (70-study mentoring synthesis) found modest average improvements across youth outcomes."));
});

// ---- list ownership -----------------------------------------------------------------

test("a claim over a parenthetical citation list is owned by every record in the list", () => {
  // Production false positive (Step 1): the compound claim was charged to the first record only.
  ok(withSection("evidence_chain", "Research supports mentoring and service learning with reflection (YM-001: modest average improvements; CB-007: mean effects between 0.27 and 0.43)."));
  ok(withSection("evidence_gaps", "**Mentoring and relational design**: Research supports one-to-one mentoring and service learning with reflection (YM-001: modest improvements; CB-007: mean effects 0.27 to 0.43; EP-017: observable competencies)."));
  // A label none of the listed records describes, where another selected record does, is still rejected.
  rejected(withSection("evidence_chain", "Research supports mentoring and financial education (YM-001: modest average improvements; EM-039: annual earnings averaged 11% higher)."), /do not report this label \(1 of 3 subject terms match\); the label describes CFSC-918/);
});

// ---- source acronyms and names -----------------------------------------------------

test("a source named by its acronym is that record's own vocabulary", () => {
  // Production false positive (Step 1): "NACE (EP-017) provides ..." charged the acronym to the record as a claim.
  ok(withSection("budget_consistency", "NACE (EP-017) provides the competency framework used for rubric definition."));
  ok(withSection("budget_consistency", "- Relevant research: NACE (EP-017) provides competency framework; MDRC research (EM-039) supports earnings gains."));
  // Another record's acronym as the label is a misleading label.
  rejected(withSection("evidence_chain", "NACE (CB-007: mean effects between 0.27 and 0.43)."), /does not report this label \(0 of 1 subject terms match\); the label describes EP-017 \(nace\)/);
  const rec = SA.recordSupport(research("EP-017", EP017));
  assert.ok(rec.stems.has("nace") && rec.stems.has("naocae"), [...rec.stems].join(" "));
  assert.ok(!SA.recordSupport(research("EM-039", EM039)).stems.has("mdr"), "a one-word source has no acronym");
});

// ---- the safety-critical rejections -----------------------------------------------

test("the safety-critical rejections are unchanged", () => {
  rejected(withSection("evidence_chain", "County ALICE households: 44% [EM-051]."), /EM-051/);
  rejected(withSection("alignment_points", "Research shows mentoring improves reading scores [CFSC-942]."), /does not report this claim/);
  rejected(withSection("evidence_chain", "Employers agreed 17% of students were below baseline proficiency [CB-007]."), /17%/);
  rejected(withSection("evidence_chain", "The county graduated 93.1% of its 2024-25 cohort."), /93\.1%/);
  rejected(withSection("alignment_points", "Career academies improved credential attainment [EM-039]."), /reports no improvement/);
  rejected(withSection("budget_consistency", "Students earn $15/hour for 10 hours/week."), /\$15/);
  rejected(withSection("evidence_chain", "Research shows mentoring improves reading scores; Florida statute requires one-half credit in personal financial literacy [CFSC-937]."), /does not report this claim/);
});

// ---- retry feedback ---------------------------------------------------------------------

test("a misleading label adds its own instruction to the regeneration feedback", () => {
  const label = { section: "evidence_chain", text: "Dual-enrollment policy", reason: "the cited record does not report this label (1 of 3 subject terms match); the label describes CTE-004 (dual, enroll)" };
  const claim = { section: "alignment_points", text: "Research shows mentoring improves reading scores", reason: "the cited record does not report this claim (1 of 3 subject terms match, none distinctive)" };
  const withLabel = validationFeedback({ code: "EVIDENCE_CHAIN", problems: [claim, label] });
  assert.match(withLabel.instruction, /A descriptive label placed before a record id, as in "Label \(ID: finding\)", must describe that record; where the label names a subject the cited record does not cover, relabel it or cite the record that covers it\.$/);
  assert.deepEqual(withLabel.problems.map((p) => p.reason), [claim.reason, label.reason]);
  const without = validationFeedback({ code: "EVIDENCE_CHAIN", problems: [claim] });
  assert.ok(!/descriptive label/.test(without.instruction));
  assert.match(without.instruction, /rewrite the sentence without making the external-research attribution\.$/);
});
