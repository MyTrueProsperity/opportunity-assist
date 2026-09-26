"use strict";
// Quantitative grounding for strategy. An applicant-specific amount, rate,
// quantity, staffing level, duration, unit cost, budget allocation or
// calculation must come from what was supplied (organization facts,
// program, application, questions, or the cited selected research).
//
// Production example (2026-09-26, revision 35): budget_consistency stated
// $15/hour, 10 hours/week, a 36-week year, ~$810,000, a $300,000 wage
// budget, $25k-$55k salaries, 0.5-1.0 FTE and $1,500+/course, none of which
// appeared in anything supplied.
const test = require("node:test");
const assert = require("node:assert/strict");
const SQ = require("../netlify/lib/grant-factory/strategy-quantities");
const SE = require("../netlify/lib/grant-factory/strategy-evidence");
const AI = require("../netlify/lib/grant-factory/ai");
const schemas = require("../netlify/lib/grant-factory/schemas.json");
const { researchVolume } = require("./helpers/research-volume");
const { service } = require("../netlify/lib/grant-factory/service");

const STRATEGY = { primary_case: "Case", funder_priorities: "Priorities", alignment_points: "Points", themes_to_emphasize: "Themes", themes_to_deemphasize: "None", likely_funding_use: "Staff", evidence_gaps: "Gaps", evidence_chain: "Need to impact", budget_consistency: "No unfunded activities found" };

// A request shaped like the one strategy receives.
const fact = (id, value) => ({ id, display_name: id, value, category: "Organization", verification_status: "APPROVED" });
const research = (record_id, finding) => ({ id: "r-" + record_id, value: finding, research: { package_version: "PKG_V1_2026-01-01", record_id, finding }, selection: { rank: 1, reasons: ["matches application terms: wage 99%"] } });
const REQUEST = {
  application: { funder_name: "County Workforce Fund", funding_purpose: "Youth employment", allowable_costs: "Staff and student wages up to $250,000 per year", match_requirement: "25% cash match required" },
  questions: [{ question_text: "Describe your program. Maximum 150 words. Due October 15, 2026.", question_category: "Program" }],
  program: { name: "Youth Workforce Program", description: "Paid work for youth." },
  facts: [
    fact("enrollment", "The Academy plans to enroll approximately 150 students in grades 9-11."),
    fact("history", "Over ten years, Bright Minds served 700+ youth."),
    research("EP-018", "96% of employers value financial literacy for career starters."),
    research("NC-029", "The median youth wage was $14.50 per hour in 2024."),
  ],
  claim_rules: [{ rule_id: "CR-1", rule: "Students may earn $15 per hour for 10 hours per week over 36 weeks." }],
  methodology_rules: [{ id: "GM-14", rule: "Budget 0.5 FTE per 50 students." }],
  organization_framework: { status: "PLANNING_FRAMEWORK_NOT_EVIDENCE", logic_model: { inputs: "$300,000 wage budget" } },
};
const check = (text, request = REQUEST, section = "budget_consistency") => SQ.unsupportedQuantities({ ...STRATEGY, [section]: text }, request);
const rejected = (text, expected, request) => {
  const out = check(text, request);
  assert.ok(out.length, "expected a rejection for: " + text);
  for (const e of expected) assert.ok(out.some((p) => p.text.includes(e)), "expected " + e + " to be rejected in: " + JSON.stringify(out));
  return out;
};
const accepted = (text, request, section) => assert.deepEqual(check(text, request, section), [], text);

test("1. an unsupported hourly wage is rejected", () => {
  rejected("Students earn $15/hour.", ["$15/hour"]);
  rejected("Students earn $15 per hour.", ["$15 per hour"]);
});
test("2. unsupported hours per week are rejected", () => rejected("Each student works 10 hours/week.", ["10"]));
test("3. unsupported weeks per year are rejected", () => {
  rejected("Work runs over a 36-week school year.", ["36"]);
  rejected("The program runs 36 weeks.", ["36"]);
});
test("4. an unsupported salary range is rejected", () => {
  const out = rejected("Service coordinator salary $25,000–$55,000.", ["$25,000", "$55,000"]);
  assert.equal(out.length, 2);
  rejected("Coordinator ($25k–$40k part-time or $40k–$55k full-time).", ["$25", "$55"]);
});
test("5. an unsupported FTE is rejected", () => {
  rejected("Service coordinator (0.5–1.0 FTE).", ["0.5", "1.0"]);
  rejected("Operational management typically 0.25–0.5 FTE per enterprise.", ["0.25", "0.5"]);
});
test("6. an unsupported unit or course cost is rejected", () => rejected("Dual-enrollment costs range from free to $1,500+/course.", ["$1,500+/course"]));
test("7. an unsupported budget allocation is rejected", () => {
  rejected("A $300,000 wage budget would support credibility.", ["$300,000"]);
  rejected("Allocate $810,000 annually to student wages.", ["$810,000"]);
});
test("8. a derived total is rejected when an input is unsupported", () => {
  const out = rejected("If 150 students × 10 hours/week × $15/hour × 36-week school year = ~$810,000 annually.", ["10", "$15/hour", "36", "$810,000"]);
  assert.ok(out.some((p) => /calculated from unsupported inputs/.test(p.reason)));
  // 150 students is a supplied fact; it is not reported.
  assert.equal(out.some((p) => p.text.startsWith("150")), false);
  rejected("50 paid-work students × 10 hours/week = 20,000 hours annually, at $15/hour = $300,000 wage budget.", ["20,000", "$300,000"]);
});
test("9. a derived total is accepted when every input is supplied and the arithmetic is right", () => {
  const req = { ...REQUEST, facts: [...REQUEST.facts, fact("wage", "Student interns are paid $15 per hour for 10 hours per week over a 36-week school year.")] };
  accepted("Wages: 150 students × 10 hours/week × $15/hour × 36 weeks = $810,000 per year.", req);
  accepted("The student wage total of $810,000 = 150 students × 10 hours/week × $15/hour × 36 weeks is below the funder cap.", req);
  // The derived total may be repeated in another section.
  const both = SQ.unsupportedQuantities({ ...STRATEGY, budget_consistency: "150 students × 10 hours/week × $15/hour × 36 weeks = $810,000.", likely_funding_use: "Student wages ($810,000)." }, req);
  assert.deepEqual(both, []);
  // Wrong arithmetic is rejected even when every input is supplied.
  const wrong = check("150 students × 10 hours/week × $15/hour × 36 weeks = $900,000.", req);
  assert.equal(wrong.length, 1);
  assert.match(wrong[0].reason, /arithmetic/);
});
test("10. supplied application and opportunity amounts are accepted", () => {
  accepted("The funder allows staff and student wages up to $250,000 per year and requires a 25% cash match.");
  accepted("The award cap for wages is $250,000.");
});
test("11. supplied organization-fact quantities are accepted", () => {
  accepted("The Academy plans approximately 150 students.", undefined, "primary_case");
  accepted("Bright Minds served 700+ youth over ten years.", undefined, "primary_case");
});
test("a supplied amount about something else does not support a claim (no coincidental matches)", () => {
  const req = { ...REQUEST, facts: [...REQUEST.facts, fact("scholarship", "Two students each received a $5,000 higher education scholarship.")] };
  rejected("Facility budget (typically $2k–$5k+/month depending on size).", ["$5"], req);
  rejected("Curriculum licensing ($5k–$20k one-time).", ["$5", "$20"], req);
  accepted("Two students each received $5,000 scholarships.", req, "primary_case");
});
test("12. selected research statistics are accepted; unselected or uncited wage figures are not", () => {
  accepted("96% of employers value financial literacy (EP-018).", undefined, "evidence_chain");
  // Uncited, the same statistic is not an unsupported quantity, but it is an
  // uncited research finding (see grant-factory-strategy-research-citations).
  accepted("National employer demand: 96% of employers value financial literacy.", undefined, "themes_to_emphasize");
  assert.ok(SQ.analyze({ ...STRATEGY, themes_to_emphasize: "National employer demand: 96% of employers value financial literacy." }, REQUEST).uncited.some((u) => u.text === "96%"));
  accepted("The median youth wage was $14.50/hour in 2024 (NC-029).", undefined, "evidence_chain");
  // A research wage used as the applicant's own rate, without citing it, is an assumption.
  rejected("Students will be paid $14.50/hour.", ["$14.50/hour"]);
  // A statistic from a record that was not selected.
  rejected("Seminole ALICE households: 44% (EM-051).", ["44"]);
  // Instructions are not support: rules, methodology and the planning
  // framework all contain these numbers.
  rejected("Students earn $15 per hour for 10 hours per week over 36 weeks.", ["$15 per hour", "10", "36"]);
  rejected("Budget 0.5 FTE per 50 students.", ["0.5"]);
  rejected("A $300,000 wage budget.", ["$300,000"]);
  // Selection reasons are not support either.
  rejected("Wage growth of 99% is expected.", ["99"]);
});
test("13. section and list numbers do not trigger false positives", () => {
  accepted("1. Need\n2. Evidence\n10. **Sustainability and Financial Model**: to be reconciled.\nSection 3, Question 2, Tier 1, Phase 2, Step 4, Year 2, Grade 12, grades 9–11.");
  accepted("Evidence: EM-011, CFSC-942, CTE_RESEARCH_004, GM-14, NC-039 and fact 229f76fd-99a1-4acc-bda3-7f600b123878.", undefined, "evidence_chain");
});
test("14. dates and deadlines do not trigger false positives", () => {
  accepted("Due October 15, 2026 at 5:00 p.m.; the Academy opens August 2027; 2023-24 cohort; history 2016–2026; submitted 9/30/2026.");
  accepted("The 2027-28 school year begins in August 2027.");
});
test("16. missing budget information is written as a gap, not an estimate", () => {
  accepted("Established: planned enrollment of approximately 150 students.\nGaps: student wage rate not yet established; weekly work hours not yet set; coordinator staffing level not yet decided.\nDecisions and actions: budget must be reconciled with the application before submission.");
  const prompt = AI.systemPrompt("strategy");
  assert.match(prompt, /name the missing input as a gap/);
  assert.match(prompt, /never estimate, assume or illustrate a number/);
  assert.match(prompt, /Established, Gaps, Decisions and actions/);
});
test("17. a production-sized strategy fits well within the 12,000-token output allowance", () => {
  assert.equal(AI.TASK_MAX_TOKENS.strategy, 12000, "the ceiling is unchanged");
  const props = schemas.strategy.properties;
  assert.deepEqual(Object.keys(props).sort(), Object.keys(STRATEGY).sort(), "all nine sections are still required");
  assert.deepEqual(schemas.strategy.required.slice().sort(), Object.keys(STRATEGY).sort());
  const words = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, Number(/At most (\d+) words/.exec(v.description)[1])]));
  const total = Object.values(words).reduce((a, b) => a + b, 0);
  assert.ok(total <= 3000, "section word guides total " + total);
  // A strategy written to every section's full word guide, in dense
  // evidence prose with record ids and numbers, as JSON tool output. Output
  // tokens are estimated at 3 characters per token, the same conservative
  // rate used for requests.
  const filler = "EP-018 (EMPLOYER_PERSPECTIVE_V1_2026-09-23) supports employer demand for financial literacy; does not support local wage levels.";
  const full = Object.fromEntries(Object.entries(words).map(([k, n]) => [k, Array.from({ length: n }, (_, i) => filler.split(" ")[i % 11]).join(" ")]));
  const estimate = SE.estimateTokens(JSON.stringify(full).length);
  assert.ok(estimate < 12000 * 0.85, "estimated " + estimate + " output tokens");
  // The prompt asks for concise, structured sections.
  assert.match(AI.systemPrompt("strategy"), /Be concise and do not repeat points across sections/);
});

// ---- End to end through the strategy job ---------------------------------

let f, s, reply, app;
test.before(async () => {
  f = await researchVolume();
  f.real.storage = f.repo.storage;
  reply = null;
  const ai = { enabled: true, async call(task, data) {
    if (task === "strategy") return { data: reply ? reply(data) : STRATEGY };
    throw Error("Unexpected task " + task);
  } };
  s = service(f.real, ai, { dispatch: (ctx, job) => s.runStrategyJob(ctx, job.id) });
  await f.pg.query("insert into gf_programs(id,org_id,content) values(gen_random_uuid(),$1,$2)", [f.ORG, JSON.stringify({ name: "Youth Workforce Program", status: "ACTIVE", tags: ["youth", "workforce"], description: "Paid work for youth.", verification_status: "APPROVED" })]);
  await f.pg.query("insert into gf_facts(id,org_id,content) values(gen_random_uuid(),$1,$2)", [f.ORG, JSON.stringify({
    fact_key: "planned_enrollment", display_name: "Planned enrollment", value: "The Academy plans to enroll approximately 150 students.", category: "Organization", verification_status: "APPROVED",
    external_use_allowed: true, grant_use_allowed: true, sensitivity_level: "INTERNAL", source_reference: "Board", source_locator: "Plan p.2" })]);
  const program = (await f.real.brain(f.ctx)).programs[0];
  app = await s.handle(f.ctx, { action: "new_application", funder_name: "County Workforce Fund", grant_program_name: "Youth employment grant", text: "1. Describe youth employment need in the county." });
  app = await s.handle(f.ctx, { action: "save_application", application_id: app.id, revision: app.revision, application: { primary_program_id: program.id } });
  // Funder terms come from the parsed opportunity, not from save_application.
  await f.pg.query("update gf_applications set content = content || $2::jsonb where id=$1", [app.id, JSON.stringify({ allowable_costs: "Student wages up to $250,000 per year" })]);
});
test.after(async () => { await f.pg.close(); });

const fresh = async () => (await s.handle(f.ctx, { action: "get_application", application_id: app.id })).app;
async function runStrategy() {
  const out = await s.handle(f.ctx, { action: "strategy", application_id: app.id, revision: (await fresh()).revision });
  return { job: (await f.pg.query("select * from gf_strategy_jobs where id=$1", [out.job.id])).rows[0], app: await fresh() };
}
const selectedIn = (req) => req.facts.filter((x) => x.research).map((x) => x.research);

test("end to end: the revision-35 budget figures fail UNSUPPORTED_QUANTITY and nothing is saved", async () => {
  reply = null;
  const before = (await runStrategy()).app;
  reply = (data) => ({ ...STRATEGY, evidence_chain: "Need: " + selectedIn(data)[0].record_id + " supports it.",
    budget_consistency: "If 150 students × 10 hours/week × $15/hour × 36-week school year = ~$810,000 annually. Coordinator (0.5–1.0 FTE, $25k–$55k). Dual enrollment up to $1,500+/course. A $300,000 wage budget." });
  const { job, app: saved } = await runStrategy();
  assert.equal(job.status, "FAILED");
  assert.equal(job.failure_code, "UNSUPPORTED_QUANTITY");
  assert.match(job.last_error, /not estimated/);
  const texts = job.result.unsupported_quantities.map((u) => u.text).join(" | ");
  for (const t of ["$15/hour", "36", "$810,000", "0.5", "$25", "$55", "$1,500+/course", "$300,000"]) assert.ok(texts.includes(t), t + " in " + texts);
  assert.equal(saved.revision, before.revision, "nothing saved");
  assert.equal(JSON.stringify(saved.content).includes("810,000"), false);
});

test("end to end: gaps, supplied quantities and cited research save", async () => {
  reply = (data) => {
    const r = selectedIn(data)[0];
    return { ...STRATEGY, primary_case: "The Academy plans approximately 150 students.",
      evidence_chain: "Need: " + r.record_id + " (" + r.package_version + ") supports local need.",
      budget_consistency: "Established: student wages are allowable up to $250,000 per year.\nGaps: student wage rate not yet established; coordinator staffing level not yet decided.\nDecisions and actions: reconcile the budget with the application before submission." };
  };
  const { job, app: saved } = await runStrategy();
  assert.equal(job.status, "COMPLETED", job.last_error + " " + JSON.stringify(job.result.unsupported_quantities || job.result.invalid_citations));
  assert.deepEqual(job.result.unsupported_quantities, []);
  assert.match(saved.content.strategy.budget_consistency, /not yet established/);
});

test("15. end to end: PR #29 citation protection still applies first", async () => {
  const brain = await f.real.brain(f.ctx);
  reply = null;
  await runStrategy();
  const before = await fresh();
  reply = (data) => {
    const picked = new Set(selectedIn(data).map((r) => r.record_id));
    const other = brain.research.records.find((r) => !picked.has(r.record_id) && r.verification_status === "PRIMARY_VERIFIED");
    return { ...STRATEGY, evidence_chain: "Need: " + other.record_id + " proves it." };
  };
  const { job, app: saved } = await runStrategy();
  assert.equal(job.failure_code, "EVIDENCE_CHAIN");
  assert.equal(saved.revision, before.revision);
});
