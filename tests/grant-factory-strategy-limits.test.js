"use strict";
// Strategy output allowance, timeout and lease, and metering of rejected AI
// responses. The real AI provider runs against a stubbed network, so these
// tests see the exact request (max_tokens, timeout) and the real rejection
// paths; the real repository records each AI run.
const test = require("node:test");
const assert = require("node:assert/strict");
const { researchVolume } = require("./helpers/research-volume");
const { service, STRATEGY_LEASE_SECONDS } = require("../netlify/lib/grant-factory/service");
const AI = require("../netlify/lib/grant-factory/ai");
const SE = require("../netlify/lib/grant-factory/strategy-evidence");

const STRATEGY = { primary_case: "Case", funder_priorities: "Priorities", alignment_points: "Points", themes_to_emphasize: "Themes", themes_to_deemphasize: "None", likely_funding_use: "Staff", evidence_gaps: "Gaps", evidence_chain: "Need to impact", budget_consistency: "No unfunded activities found" };
const USAGE = { input_tokens: 101234, output_tokens: 12000 };

// A provider response as the Messages API returns it.
const reply = ({ input = STRATEGY, stop = "tool_use", usage = USAGE } = {}) => ({
  ok: true, status: 200,
  json: async () => ({ stop_reason: stop, content: [{ type: "tool_use", name: "result", input }], ...(usage ? { usage } : {}) }),
});

let f, s, net, program, app, timeouts;
const realTimeout = AbortSignal.timeout;
test.before(async () => {
  f = await researchVolume();
  f.real.storage = f.repo.storage;
  net = { requests: [], next: () => reply() };
  timeouts = [];
  AbortSignal.timeout = (ms) => { timeouts.push(ms); return realTimeout.call(AbortSignal, ms); };
  const provider = AI.provider({ ANTHROPIC_API_KEY: "k" }, async (url, init) => { net.requests.push(JSON.parse(init.body)); return net.next(); });
  s = service(f.real, provider, { dispatch: async () => {} });
  await f.pg.query("insert into gf_programs(id,org_id,content) values(gen_random_uuid(),$1,$2)", [f.ORG, JSON.stringify({ name: "Youth Workforce Program", status: "ACTIVE", tags: ["youth", "workforce"], description: "Paid work for youth.", verification_status: "APPROVED" })]);
  program = (await f.real.brain(f.ctx)).programs[0];
  app = await s.handle(f.ctx, { action: "new_application", funder_name: "County Workforce Fund", grant_program_name: "Youth employment grant", text: "1. Describe youth employment need in the county." });
  app = await s.handle(f.ctx, { action: "save_application", application_id: app.id, revision: app.revision, application: { primary_program_id: program.id } });
});
test.after(async () => { AbortSignal.timeout = realTimeout; await f.pg.close(); });

const fresh = async () => (await s.handle(f.ctx, { action: "get_application", application_id: app.id })).app;
async function runJob() {
  await f.pg.query("delete from gf_strategy_jobs");
  const { job } = await s.handle(f.ctx, { action: "strategy", application_id: app.id, revision: (await fresh()).revision });
  const out = await s.runStrategyJob(f.ctx, job.id);
  const row = (await f.pg.query("select * from gf_strategy_jobs where id=$1", [job.id])).rows[0];
  const run = (await f.pg.query("select * from gf_ai_runs where org_id=$1 and task='strategy' order by created_at desc limit 1", [f.ORG])).rows[0];
  return { out, row, run };
}
async function approved(text) {
  const a = await fresh();
  await s.handle(f.ctx, { action: "save_application", application_id: a.id, revision: a.revision, application: { strategy: { ...STRATEGY, primary_case: text }, strategy_approved: true } });
}

test("strategy may use 12,000 output tokens and 300 seconds; other tasks keep their limits", async () => {
  assert.equal(AI.TASK_MAX_TOKENS.strategy, 12000);
  assert.equal(AI.TASK_TIMEOUT_MS.strategy, 300000);
  assert.deepEqual({ ...AI.TASK_MAX_TOKENS, strategy: undefined }, { parse: 12000, extract_facts: 6500, strategy: undefined });
  assert.equal(AI.DEFAULT_MAX_TOKENS, 4500);
  assert.deepEqual(Object.keys(AI.TASK_TIMEOUT_MS), ["strategy"], "only strategy has a longer timeout");
  // What each task actually sends.
  const seen = {};
  const p = AI.provider({ ANTHROPIC_API_KEY: "k" }, async (url, init) => { const b = JSON.parse(init.body); seen.last = b; return reply({ input: {} }); });
  timeouts.length = 0;
  for (const task of ["strategy", "write", "audit"]) {
    await p.call(task, task === "audit" ? { answer: "One sentence." } : {}).catch(() => {});
    seen[task] = { max: seen.last.max_tokens, timeout: timeouts.at(-1) };
  }
  assert.deepEqual(seen.strategy, { max: 12000, timeout: 300000 });
  assert.deepEqual(seen.write, { max: 4500, timeout: 45000 }, "drafting unchanged");
  assert.deepEqual(seen.audit, { max: 4500, timeout: 45000 }, "audit unchanged");
});

test("a strategy job holds a 7-minute lease, above the model timeout", async () => {
  assert.equal(STRATEGY_LEASE_SECONDS, 420);
  assert.ok(STRATEGY_LEASE_SECONDS > AI.TASK_TIMEOUT_MS.strategy / 1000 + 60);
  assert.ok(STRATEGY_LEASE_SECONDS < 900, "well inside the 15-minute background limit");
  let lease;
  await f.pg.query("delete from gf_strategy_jobs");
  const { job } = await s.handle(f.ctx, { action: "strategy", application_id: app.id, revision: (await fresh()).revision });
  // Observe the lease the database granted while the model runs.
  net.next = () => {
    lease = f.pg.query("select extract(epoch from lease_until - started_at)::int s from gf_strategy_jobs where id=$1", [job.id]);
    return reply();
  };
  await s.runStrategyJob(f.ctx, job.id);
  assert.equal((await lease).rows[0].s, 420);
});

test("a complete 12,000-token strategy is saved, with usage metered", async () => {
  net.next = () => reply({ usage: { input_tokens: 99000, output_tokens: 11200 } });
  const { out, row, run } = await runJob();
  assert.equal(out.status, "COMPLETED");
  assert.equal(net.requests.at(-1).max_tokens, 12000);
  const a = await fresh();
  for (const k of Object.keys(STRATEGY)) assert.equal(a.content.strategy[k], STRATEGY[k], k);
  assert.equal(a.content.strategy_evidence.output_tokens, 11200);
  assert.equal(row.result.input_tokens, 99000);
  assert.equal(run.status, "COMPLETE");
  assert.equal(run.output_tokens, 11200);
});

test("hitting the output allowance is still rejected; nothing partial is saved; the usage is metered", async () => {
  await approved("Approved before");
  const before = await fresh();
  net.next = () => reply({ stop: "max_tokens", input: { primary_case: "Partial" }, usage: { input_tokens: 119000, output_tokens: 12000 } });
  const { out, row, run } = await runJob();
  assert.equal(out.status, "FAILED");
  assert.match(out.error, /incomplete/);
  const after = await fresh();
  assert.equal(after.revision, before.revision, "nothing saved");
  assert.equal(after.content.strategy.primary_case, "Approved before");
  assert.equal(JSON.stringify(after.content).includes("Partial"), false, "no partial text anywhere");
  assert.equal(run.status, "FAILED", "the AI run stays failed");
  assert.equal(run.input_tokens, 119000, "its cost is recorded");
  assert.equal(run.output_tokens, 12000);
  assert.match(run.error, /incomplete/);
  assert.equal(row.status, "FAILED");
  assert.equal(row.result.output_tokens, 12000, "the job records the usage too");
});

test("a structurally incomplete result is rejected and metered", async () => {
  await approved("Still approved");
  const { primary_case, ...missing } = STRATEGY;
  net.next = () => reply({ input: missing, usage: { input_tokens: 90000, output_tokens: 3000 } });
  const { out, run } = await runJob();
  assert.equal(out.status, "FAILED");
  assert.equal((await fresh()).content.strategy.primary_case, "Still approved");
  assert.equal(run.status, "FAILED");
  assert.equal(run.output_tokens, 3000);
});

test("an evidence-chain rejection keeps the completed AI call's usage and saves nothing", async () => {
  await approved("Unchanged");
  net.next = () => reply({ input: { ...STRATEGY, evidence_chain: "Need: GW-249 proves it." }, usage: { input_tokens: 95000, output_tokens: 6000 } });
  const { out, row, run } = await runJob();
  assert.equal(out.failure_code, "EVIDENCE_CHAIN");
  assert.equal((await fresh()).content.strategy.primary_case, "Unchanged");
  assert.equal(run.status, "COMPLETE", "the provider call itself completed");
  assert.equal(run.output_tokens, 6000);
  assert.equal(row.result.output_tokens, 6000);
});

test("no usage is invented when the provider reports none", async () => {
  net.next = () => reply({ stop: "max_tokens", usage: null });
  const { run, row } = await runJob();
  assert.equal(run.status, "FAILED");
  assert.equal(run.input_tokens, null);
  assert.equal(run.output_tokens, null);
  assert.equal(row.result.input_tokens ?? null, null);
});

test("a worker that lost its 7-minute lease still cannot save", async () => {
  await approved("Kept");
  await f.pg.query("delete from gf_strategy_jobs");
  const { job } = await s.handle(f.ctx, { action: "strategy", application_id: app.id, revision: (await fresh()).revision });
  net.next = () => {
    return f.pg.query("update gf_strategy_jobs set lease_until=now()-interval '1 second' where id=$1", [job.id])
      .then(() => s.handle(f.ctx, { action: "strategy_status", application_id: app.id }))
      .then(() => reply({ input: { ...STRATEGY, primary_case: "Late" } }));
  };
  const out = await s.runStrategyJob(f.ctx, job.id);
  assert.equal(out.failure_code, "EXPIRED");
  assert.equal((await fresh()).content.strategy.primary_case, "Kept");
});

test("evidence selection and the input budget are unchanged", () => {
  assert.equal(SE.STRATEGY_RESEARCH_MAX, 40);
  assert.equal(SE.STRATEGY_TOKEN_BUDGET, 120000);
  assert.equal(SE.EVIDENCE_REQUEST_TOKEN_BUDGET, 150000);
  assert.equal(SE.CHARS_PER_TOKEN, 3);
  assert.equal(SE.PACKAGE_SHARE, 0.6);
  // The strategy request the provider received is still the bounded selection.
  const last = net.requests.filter((r) => r.max_tokens === 12000).at(-1);
  const data = JSON.parse(last.messages[0].content);
  const research = data.facts.filter((x) => x.research);
  assert.ok(research.length > 0 && research.length <= 40);
  assert.ok(research.every((x) => x.verification_status === "VERIFIED" && x.research.does_not_support?.length));
  assert.ok(SE.estimateTokens(AI.requestChars("strategy", data)) <= SE.STRATEGY_TOKEN_BUDGET + 1000);
});
