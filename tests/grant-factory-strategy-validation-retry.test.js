"use strict";
// One automatic regeneration after strategy-content validation rejects a
// completed model response, and the two validator fixes from the PR #34
// first-run production validation (2026-09-27, job 7abbcab4):
//   - "Do not turn national research findings (... meta-analyses ...) into
//     local prevalence estimates" is an instruction, not a claim;
//   - "... establish baseline and outcome measures aligned with national
//     frameworks [EP-017], and document partner letters" is checked against
//     the phrase the citation is attached to, not the whole recommendation;
//   - "only 55.4% rate graduate communication as proficient [EP-018]" is a
//     wrong record (55.4% is in EP-014) and stays rejected.
const test = require("node:test");
const assert = require("node:assert/strict");
const SQ = require("../netlify/lib/grant-factory/strategy-quantities");
const SE = require("../netlify/lib/grant-factory/strategy-evidence");
const { researchVolume } = require("./helpers/research-volume");
const { service, STRATEGY_LEASE_SECONDS } = require("../netlify/lib/grant-factory/service");
const AI = require("../netlify/lib/grant-factory/ai");

const STRATEGY = { primary_case: "Case", funder_priorities: "Priorities", alignment_points: "Points", themes_to_emphasize: "Themes", themes_to_deemphasize: "None", likely_funding_use: "Staff", evidence_gaps: "Gaps", evidence_chain: "Need to impact", budget_consistency: "No unfunded activities found" };
const PKG = "PKG_V1_2026-01-01";
const research = (record_id, r) => ({ id: "r-" + record_id, display_name: record_id + " · " + r.topic, value: r.finding, research: { package_version: PKG, record_id, ...r }, selection: { rank: 1, reasons: ["planning aid"] } });

// ---- The three production sentences -----------------------------------------

// As the production library holds them.
const EP014 = { topic: "Employer perspective: Job Outlook 2026 Spring Update", finding: "Communication importance/proficiency: 98.7%/55.4%; professionalism: 94.1%/54.7%; critical thinking: 93.5%/50.0%; teamwork: 96.1%/75.0%. Initiative was sought on résumés by 69%.", supports: ["Employer priorities and perceived readiness of college graduates."], population: "Employers recruiting college graduates" };
const EP017 = { topic: "Employer perspective: What Is Career Readiness", finding: "Communication, critical thinking, professionalism, teamwork, and career/self-development are separate competencies illustrated through observable behaviors.", supports: ["A common vocabulary for expectations and assessment."], population: "Students, interns, new hires, employers and educators" };
const EP018 = { topic: "Employer views of workforce readiness", finding: "96% valued financial literacy for career starters. 94% said demonstrated problem solving/critical thinking made them more likely to hire an entry-level candidate; 90% said this for communication. 84% agreed that most high school students were not prepared to enter the workforce.", supports: ["Employer interest in financial capability and demonstrated workplace skills."] };
const CFSC942 = { topic: "Youth financial literacy proficiency", finding: "An estimated 17% of US students were below baseline Level 2 financial-literacy proficiency.", supports: ["National financial-literacy need among assessed youth."] };
const REQUEST = {
  application: { funder_name: "County Workforce Fund" }, questions: [{ question_text: "Describe your program." }], program: { name: "Academy" },
  facts: [{ id: "o1", display_name: "History", value: "Bright Minds operated 2016-2025 with 123+ alumni.", category: "Organization" },
    research("EP-014", EP014), research("EP-017", EP017), research("EP-018", EP018), research("CFSC-942", CFSC942)],
};
const BUNDLE = { records: REQUEST.facts.filter((f) => f.research).map((f) => f.research), aliases: [] };
const CHAIN = "Need: 84% of employers agree most high school students are not prepared [EP-018].";
const analyze = (section, text) => SQ.analyze({ ...STRATEGY, evidence_chain: CHAIN, [section]: section === "evidence_chain" ? CHAIN + " " + text : text }, REQUEST, BUNDLE);
const clean = (a) => { assert.deepEqual([a.unsupported, a.uncited], [[], []], JSON.stringify(a)); };

test("the exact 55.4%/EP-018 production sentence is rejected: the number is in EP-014, not the cited record", () => {
  const a = analyze("evidence_chain", "National employer surveys report that 84% of surveyed employers agree most high-school students are not prepared for workforce entry; only 55.4% rate graduate communication as proficient [EP-018]; and financial literacy is valued by 96% but education coverage varies [CFSC-942 shows 17% of U.S. assessed students below baseline financial proficiency].");
  assert.ok(a.uncited.some((u) => u.text === "55.4%" && /does not contain this number \(found in EP-014\)/.test(u.reason)), JSON.stringify(a.uncited));
  // Cited to the record that contains it, it passes.
  clean(analyze("evidence_chain", "National employer surveys report that 84% of surveyed employers agree most high-school students are not prepared for workforce entry [EP-018]; only 55.4% rate graduate communication as proficient [EP-014]."));
});

test("the exact themes_to_deemphasize instruction is not a research claim; the same cue as a claim still is", () => {
  clean(analyze("themes_to_deemphasize", "Do not turn national research findings (employer readiness surveys, financial education meta-analyses, service-learning synthesis) into local prevalence estimates or Bright Minds outcome predictions."));
  for (const sentence of ["Avoid citing meta-analyses as Bright Minds outcomes.", "Never present a randomized trial as a local result.", "Is there a meta-analysis on this?", "No meta-analysis was supplied for local prevalence."])
    clean(analyze("themes_to_deemphasize", sentence));
  // Affirmative uses of the older cues still need an id.
  for (const [sentence, cue] of [["A meta-analysis shows financial education improves behavior.", /meta-analysis/], ["Kaiser et al. found gains.", /et al/], ["Randomized trials show gains.", /Randomized trials/]]) {
    const a = analyze("alignment_points", sentence);
    assert.ok(a.uncited.some((u) => cue.test(u.reason)), sentence + " " + JSON.stringify(a.uncited));
  }
});

test("the exact EP-017 recommendation is checked against the phrase its citation belongs to", () => {
  clean(analyze("evidence_gaps", "**Decisions and actions:** Before submission to a funder, secure facility details, finalize curriculum scope, establish baseline and outcome measures aligned with national frameworks [EP-017], and document partner letters of commitment."));
  // Just as strict about what the record reports: an unrelated phrase fails.
  const a = analyze("evidence_gaps", "**Decisions and actions:** Before submission to a funder, secure facility details, finalize curriculum scope, establish baseline counts of attendance and discipline referrals [EP-017], and document partner letters of commitment.");
  assert.ok(a.uncited.some((u) => /does not report this claim/.test(u.reason)), JSON.stringify(a.uncited));
  const b = analyze("alignment_points", "Research shows mentoring improves reading scores [EP-018].");
  assert.ok(b.uncited.some((u) => /does not report this claim/.test(u.reason)), JSON.stringify(b.uncited));
});

// ---- One automatic regeneration -------------------------------------------------

let f, svc, replies, app, calls, fail;
test.before(async () => {
  f = await researchVolume();
  f.real.storage = f.repo.storage;
  const ai = { enabled: true, async call(task, data) {
    if (task !== "strategy") throw Error("Unexpected task " + task);
    calls.push(data);
    if (fail) { const e = fail(calls.length); if (e) throw e; }
    const next = replies[Math.min(calls.length - 1, replies.length - 1)];
    return { data: next ? next(data) : STRATEGY, usage: { input_tokens: 1000 + calls.length, output_tokens: 200 + calls.length }, model: "test-model" };
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
  calls = [];
  const before = Number((await f.pg.query("select count(*) n from gf_ai_runs where task='strategy'")).rows[0].n);
  const out = await svc.handle(f.ctx, { action: "strategy", application_id: app.id, revision: (await fresh()).revision });
  const job = (await f.pg.query("select * from gf_strategy_jobs where id=$1", [out.job.id])).rows[0];
  const runs = (await f.pg.query("select status, input_tokens, output_tokens from gf_ai_runs where task='strategy' order by created_at")).rows.slice(before);
  return { job, app: await fresh(), runs };
}
const BAD = "Research shows paid work builds professional skills and national surveys document employer demand.";
const bad = () => ({ ...STRATEGY, alignment_points: BAD, evidence_chain: "Need to impact; no local outcome data yet." });
const good = (data) => {
  const r = data.facts.filter((x) => x.research)[0].research;
  const pct = /(\d+(?:\.\d+)?)%/.exec(String(r.finding));
  return { ...STRATEGY, evidence_chain: "Need: " + (pct ? pct[0] + " " : "") + "finding [" + r.record_id + "] supports local need; does not support program effect." };
};

test("a rejected first generation gets one completely new generation, with structured feedback, and the valid result is saved", async () => {
  replies = [bad, good]; fail = null;
  const before = (await fresh()).revision;
  const { job, app: saved, runs } = await runStrategy();
  assert.equal(job.status, "COMPLETED", job.last_error);
  assert.equal(calls.length, 2, "exactly one regeneration");
  assert.equal(job.result.generations, 2);
  assert.equal(job.result.attempts.length, 2);
  assert.equal(job.result.attempts[0].failure_code, "EVIDENCE_CHAIN");
  assert.equal(job.result.attempts[1].failure_code, null);
  // The regeneration is a new request with feedback, not the rejected text to patch.
  const fb = calls[1].validation_feedback;
  assert.ok(fb && /completely new strategy/.test(fb.instruction));
  // Both the specific errors and the general citation rule.
  assert.match(fb.instruction, /every sentence that affirmatively attributes a finding or conclusion to external research, studies, surveys, literature, evaluations or research evidence must contain the supporting canonical selected research record ID in that sentence/i);
  assert.match(fb.instruction, /rewrite the sentence without making the external-research attribution/i);
  assert.equal(fb.failure_code, "EVIDENCE_CHAIN");
  assert.ok(fb.problems.length >= 1 && fb.problems.length <= 12);
  assert.ok(fb.problems.some((p) => p.text.includes(BAD.slice(0, 40)) && /record id/.test(p.reason)), "the specific rejected sentence is in the feedback");
  assert.ok(fb.problems.every((p) => p.text.length <= 160 && p.reason.length <= 200));
  assert.equal(calls[0].validation_feedback, undefined);
  assert.equal(JSON.stringify(calls[1]).includes('"alignment_points":"' + BAD), false, "the rejected strategy is not sent back");
  // The same evidence request: selection, cap and budget unchanged.
  const { validation_feedback, ...rest } = calls[1];
  assert.deepEqual(rest, calls[0]);
  assert.ok(calls[0].facts.filter((x) => x.research).length <= SE.STRATEGY_RESEARCH_MAX);
  // Saved strategy is the second generation; the first is never on the application.
  assert.ok(saved.revision > before);
  assert.equal(saved.content.strategy.approved, false);
  assert.equal(JSON.stringify(saved.content).includes(BAD), false);
  assert.equal(saved.content.strategy_evidence.job_id, job.id);
  // Both calls logged and metered independently.
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => [r.status, r.input_tokens, r.output_tokens]), [["COMPLETE", 1001, 201], ["COMPLETE", 1002, 202]]);
  // The rejected first generation is kept for authorized diagnosis.
  assert.equal(job.result.rejected_attempts.length, 1);
  assert.equal(job.result.rejected_attempts[0].strategy.alignment_points, BAD);
  const { rejection } = await svc.handle(f.ctx, { action: "strategy_rejection", application_id: app.id });
  assert.equal(rejection.status, "REJECTED");
  assert.equal(rejection.job_status, "COMPLETED");
  assert.equal(rejection.current, false);
  assert.equal(rejection.approvable, false);
  assert.equal(rejection.rejected_attempts[0].strategy.alignment_points, BAD);
  // Drafting uses the saved strategy after approval, never the rejected text.
  const approved = await svc.handle(f.ctx, { action: "save_application", application_id: app.id, revision: saved.revision, application: { strategy_approved: true } });
  assert.equal(approved.content.strategy.approved, true);
  assert.equal(JSON.stringify(approved.content).includes(BAD), false);
});

test("if the regeneration is also rejected, the job fails safely, nothing is saved, and no third generation runs", async () => {
  replies = [bad, () => ({ ...STRATEGY, themes_to_emphasize: "Studies demonstrate gains in youth employment.", evidence_chain: "Need to impact." })]; fail = null;
  const before = await fresh();
  const { job, app: saved, runs } = await runStrategy();
  assert.equal(job.status, "FAILED");
  assert.equal(job.failure_code, "EVIDENCE_CHAIN");
  assert.match(job.last_error, /automatic regeneration was also rejected/);
  assert.equal(calls.length, 2);
  assert.equal(runs.length, 2);
  assert.equal(job.result.generations, 2);
  assert.equal(saved.revision, before.revision, "nothing saved");
  assert.deepEqual(saved.content.strategy, before.content.strategy);
  assert.equal(job.result.rejected_attempts.length, 2);
  assert.equal(job.result.rejected_strategy.themes_to_emphasize, "Studies demonstrate gains in youth employment.");
  const { rejection } = await svc.handle(f.ctx, { action: "strategy_rejection", application_id: app.id });
  assert.equal(rejection.job_status, "FAILED");
  assert.equal(rejection.rejected_attempts.length, 2);
  // At most one rejected-output job per application.
  assert.equal((await f.pg.query("select count(*) n from gf_strategy_jobs where application_id=$1 and (result ? 'rejected_strategy' or result ? 'rejected_attempts')", [app.id])).rows[0].n, 1);
});

test("the second generation is subject to every existing validator", async () => {
  const cases = [
    ["selected-record allowlist", () => ({ ...STRATEGY, alignment_points: "Mentoring improves outcomes [GW-250]." }), "EVIDENCE_CHAIN", (r) => r.invalid_citations.includes("GW-250")],
    ["uncited research attribution", () => ({ ...STRATEGY, alignment_points: "National research supports the program's integrated approach." }), "EVIDENCE_CHAIN", (r) => r.uncited_research.some((u) => /research supports/.test(u.reason))],
    ["substantive support", (data) => ({ ...STRATEGY, alignment_points: "Research shows violin lessons raise toddler sleep duration [" + data.facts.filter((x) => x.research)[0].research.record_id + "]." }), "EVIDENCE_CHAIN", (r) => r.uncited_research.some((u) => /does not report this claim/.test(u.reason))],
    ["quantitative grounding", () => ({ ...STRATEGY, budget_consistency: "Students earn $15/hour for 10 hours/week." }), "UNSUPPORTED_QUANTITY", (r) => r.unsupported_quantities.some((u) => u.text === "$15/hour")],
  ];
  for (const [name, second, code, check] of cases) {
    replies = [bad, second]; fail = null;
    const before = await fresh();
    const { job, app: saved, runs } = await runStrategy();
    assert.equal(job.status, "FAILED", name);
    assert.equal(job.failure_code, code, name);
    assert.equal(calls.length, 2, name);
    assert.equal(runs.length, 2, name);
    assert.equal(job.result.generations, 2, name);
    assert.ok(check(job.result), name + ": " + JSON.stringify(job.result.attempts[1]));
    assert.equal(saved.revision, before.revision, name + ": nothing saved");
  }
});

test("a valid first generation is saved with no regeneration", async () => {
  replies = [good]; fail = null;
  const { job, runs } = await runStrategy();
  assert.equal(job.status, "COMPLETED", job.last_error);
  assert.equal(calls.length, 1);
  assert.equal(runs.length, 1);
  assert.equal(job.result.generations, 1);
  assert.equal(job.result.rejected_attempts, undefined);
  await assert.rejects(svc.handle(f.ctx, { action: "strategy_rejection", application_id: app.id }), (e) => e.status === 404);
});

test("provider, timeout and other non-content failures are never retried", async () => {
  for (const [error, code] of [[Object.assign(Error("provider unavailable"), { status: 503 }), "AI_FAILED"], [Object.assign(Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), "AI_TIMEOUT"], [Error("AI result was incomplete"), "AI_FAILED"]]) {
    replies = [good]; fail = () => error;
    const { job, runs } = await runStrategy();
    assert.equal(job.status, "FAILED");
    assert.equal(job.failure_code, code);
    assert.equal(calls.length, 1, code + " is not retried");
    assert.equal(runs.length, 1);
  }
  // A provider failure on the regeneration ends the job; it is not retried again.
  replies = [bad, good]; fail = (n) => (n === 2 ? Error("provider unavailable") : null);
  const { job } = await runStrategy();
  assert.equal(job.status, "FAILED");
  assert.equal(job.failure_code, "AI_FAILED");
  assert.equal(calls.length, 2);
  assert.equal(job.result.generations, 2);
  fail = null;
});

test("the lease covers two model calls inside the background limit", () => {
  assert.ok(STRATEGY_LEASE_SECONDS > 2 * AI.TASK_TIMEOUT_MS.strategy / 1000 + 60);
  assert.ok(STRATEGY_LEASE_SECONDS < 900);
});

test("another organization cannot run, see or read rejected output for this application", async () => {
  replies = [bad, bad]; fail = null;
  await runStrategy();
  assert.ok((await svc.handle(f.ctx, { action: "strategy_rejection", application_id: app.id })).rejection);
  await assert.rejects(svc.handle(f.otherCtx, { action: "strategy_rejection", application_id: app.id }), (e) => e.status === 404);
  await assert.rejects(svc.handle({ org_id: f.ORG, user_id: f.OUTSIDER, role: "OWNER" }, { action: "strategy_rejection", application_id: app.id }));
  const job = (await f.pg.query("select id from gf_strategy_jobs where application_id=$1 order by created_at desc limit 1", [app.id])).rows[0];
  assert.equal((await svc.runStrategyJob(f.otherCtx, job.id)).claimed, false);
});
