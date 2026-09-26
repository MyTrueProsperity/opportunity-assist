"use strict";
// Background strategy generation: queueing, job states, atomic saving,
// duplicate and stale protection, authorization, timeouts and usage logging.
// Uses the real repository and job RPCs over the production-sized synthetic
// research library (no private research).
const test = require("node:test");
const assert = require("node:assert/strict");
const { researchVolume } = require("./helpers/research-volume");
const { service } = require("../netlify/lib/grant-factory/service");
const C = require("../netlify/lib/grant-factory/core");
const SE = require("../netlify/lib/grant-factory/strategy-evidence");
const AI = require("../netlify/lib/grant-factory/ai");
const { strategyDispatcher, makeHandler: gfHandler } = require("../netlify/functions/grant-factory");
const { makeHandler: bgHandler } = require("../netlify/functions/grant-factory-strategy-background");
const { repository } = require("../netlify/lib/grant-factory/repository");

const STRATEGY = { primary_case: "Case", funder_priorities: "Priorities", alignment_points: "Points", themes_to_emphasize: "", themes_to_deemphasize: "", likely_funding_use: "", evidence_gaps: "Gaps", evidence_chain: "Need to impact", budget_consistency: "No unfunded activities found" };
const USAGE = { input_tokens: 81234, output_tokens: 2345 };

let f, s, ai, dispatched, program, app;
test.before(async () => {
  f = await researchVolume();
  f.real.storage = f.repo.storage;
  dispatched = [];
  ai = {
    enabled: true, calls: 0, behavior: null,
    async call(task, data) {
      this.calls++;
      this.last = data;
      if (this.behavior) return this.behavior(task, data);
      return { data: STRATEGY, model: "test-model", usage: USAGE };
    },
  };
  // Dispatch only records the job; tests run the worker explicitly.
  s = service(f.real, ai, { dispatch: async (ctx, job) => { dispatched.push({ org: ctx.org_id, job: job.id }); } });
  await f.pg.query("insert into gf_programs(id,org_id,content) values(gen_random_uuid(),$1,$2)", [f.ORG, JSON.stringify({ name: "Youth Workforce Program", status: "ACTIVE", tags: ["youth", "workforce"], description: "Paid work for youth.", verification_status: "APPROVED" })]);
  program = (await f.real.brain(f.ctx)).programs[0];
  app = await s.handle(f.ctx, { action: "new_application", funder_name: "County Workforce Fund", grant_program_name: "Youth employment grant", text: "1. Describe youth employment need in the county." });
  app = await s.handle(f.ctx, { action: "save_application", application_id: app.id, revision: app.revision, application: { primary_program_id: program.id } });
});
test.after(async () => { await f.pg.close(); });

const fresh = async () => (await s.handle(f.ctx, { action: "get_application", application_id: app.id })).app;
const start = async (svc = s, ctx = f.ctx) => svc.handle(ctx, { action: "strategy", application_id: app.id, revision: (await fresh()).revision });
const status = async (ctx = f.ctx) => (await s.handle(ctx, { action: "strategy_status", application_id: app.id })).job;
const jobRow = async (id) => (await f.pg.query("select * from gf_strategy_jobs where id=$1", [id])).rows[0];
const aiRuns = async () => (await f.pg.query("select task,status,input_tokens,output_tokens,error,created_at from gf_ai_runs where org_id=$1 order by created_at", [f.ORG])).rows;
const reset = async () => { ai.behavior = null; dispatched.length = 0; await f.pg.query("delete from gf_strategy_jobs"); };
async function saveApprovedStrategy(text) {
  const a = await fresh();
  return s.handle(f.ctx, { action: "save_application", application_id: a.id, revision: a.revision, application: { strategy: { ...STRATEGY, primary_case: text }, strategy_approved: true } });
}

test("generating strategy queues a background job and returns without waiting for the AI", async () => {
  await reset();
  const before = ai.calls;
  const t0 = Date.now();
  const out = await start();
  assert.equal(ai.calls, before, "no AI call in the request");
  assert.equal(out.created, true);
  assert.equal(out.job.status, "QUEUED");
  assert.equal(out.job.application_id, app.id);
  assert.deepEqual(dispatched, [{ org: f.ORG, job: out.job.id }], "the background worker is dispatched once");
  assert.ok(Date.now() - t0 < 15000);
  assert.ok(JSON.stringify(out).length < 1000, "the response is a small job summary");
  const row = await jobRow(out.job.id);
  assert.equal(row.requested_by, f.OWNER);
  assert.equal(row.org_id, f.ORG);
  assert.ok(row.dispatched_at, "dispatch is recorded");
  assert.equal("lease_token" in out.job, false);
});

test("repeated clicks join the active job instead of creating another", async () => {
  await reset();
  const a = await start();
  const b = await start();
  const c = await start();
  assert.equal(b.job.id, a.job.id);
  assert.equal(c.job.id, a.job.id);
  assert.equal(b.created, false);
  assert.equal(dispatched.length, 1);
  assert.equal((await f.pg.query("select count(*)::int n from gf_strategy_jobs where application_id=$1", [app.id])).rows[0].n, 1);
});

test("status polling is lightweight and sees QUEUED, RUNNING and COMPLETED", async () => {
  await reset();
  const { job } = await start();
  let brainLoads = 0;
  const brain = f.real.brain;
  f.real.brain = async (...a) => { brainLoads++; return brain.apply(f.real, a); };
  try {
    const polled = await s.handle(f.ctx, { action: "strategy_status", application_id: app.id });
    assert.equal(polled.job.status, "QUEUED");
    assert.equal(brainLoads, 0, "polling never loads research or the brain");
    assert.ok(JSON.stringify(polled).length < 1000);
  } finally { f.real.brain = brain; }
  let seenRunning;
  ai.behavior = async () => { seenRunning = await status(); return { data: STRATEGY, model: "test-model", usage: USAGE }; };
  const out = await s.runStrategyJob(f.ctx, job.id);
  assert.equal(seenRunning.status, "RUNNING");
  assert.ok(seenRunning.started_at);
  assert.equal(out.status, "COMPLETED");
  const done = await status();
  assert.equal(done.status, "COMPLETED");
  assert.ok(done.finished_at && done.research_selected > 0 && done.strategy_revision);
  // Running the same job again (a duplicate dispatch) does nothing.
  const again = await s.runStrategyJob(f.ctx, job.id);
  assert.equal(again.claimed, false);
});

test("a completed job saves a complete strategy built from bounded, eligible evidence, with usage recorded", async () => {
  await reset();
  const { job } = await start();
  await s.runStrategyJob(f.ctx, job.id);
  const a = await fresh();
  assert.deepEqual({ ...a.content.strategy, approved: undefined }, { ...STRATEGY, approved: undefined });
  assert.equal(a.content.strategy.approved, false, "a generated strategy always needs review");
  const ev = a.content.strategy_evidence;
  assert.equal(ev.job_id, job.id);
  assert.ok(ev.research_selected > 0 && ev.research_selected <= SE.STRATEGY_RESEARCH_MAX);
  assert.ok(ev.estimated_tokens <= SE.STRATEGY_TOKEN_BUDGET);
  assert.equal(ev.input_tokens, USAGE.input_tokens);
  assert.equal(ev.model, "test-model");
  // The request the AI received is PR #26's bounded selection.
  const research = ai.last.facts.filter((x) => x.research);
  assert.equal(research.length, ev.research_selected);
  assert.ok(research.every((x) => x.verification_status === "VERIFIED" && x.research.external_use_status === "VERIFIED"));
  assert.ok(research.every((x) => x.research.does_not_support?.length && x.research.prohibited_language?.length));
  assert.ok(research.every((x) => !("source_fields_original" in x.research)));
  const brain = await f.real.brain(f.ctx);
  const gated = new Set(brain.facts.filter((x) => x.research && x.verification_status !== "VERIFIED").map((x) => x.id));
  assert.ok(gated.size > 300);
  assert.ok(research.every((x) => !gated.has(x.id)), "review-gated research never selected");
  assert.ok(SE.estimateTokens(AI.requestChars("strategy", ai.last)) <= SE.EVIDENCE_REQUEST_TOKEN_BUDGET, "request-size guard still holds");
  const row = await jobRow(job.id);
  assert.equal(row.status, "COMPLETED");
  assert.equal(row.result.input_tokens, USAGE.input_tokens);
  assert.equal(row.result.output_tokens, USAGE.output_tokens);
  assert.equal(JSON.stringify(row.result).includes("approved_language"), false, "the job row holds metadata, not research text");
  const runs = await aiRuns();
  const last = runs.filter((r) => r.task === "strategy").at(-1);
  assert.equal(last.status, "COMPLETE");
  assert.equal(last.input_tokens, USAGE.input_tokens);
});

test("an AI failure or timeout never overwrites the existing strategy, is logged, and can be retried", async () => {
  await reset();
  await saveApprovedStrategy("Approved earlier");
  const before = await fresh();
  ai.behavior = async () => { throw Object.assign(Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); };
  const { job } = await start();
  const out = await s.runStrategyJob(f.ctx, job.id);
  assert.equal(out.failure_code, "AI_TIMEOUT");
  const after = await fresh();
  assert.equal(after.content.strategy.primary_case, "Approved earlier");
  assert.equal(after.content.strategy.approved, true, "the approved strategy is untouched");
  assert.equal(after.revision, before.revision, "nothing was saved");
  assert.equal((await status()).status, "FAILED");
  assert.equal((await aiRuns()).filter((r) => r.task === "strategy").at(-1).status, "FAILED", "the failed AI call is logged");
  // Retry after a genuine failure creates a new job.
  ai.behavior = null;
  const retry = await start();
  assert.equal(retry.created, true);
  assert.notEqual(retry.job.id, job.id);
  assert.equal((await s.runStrategyJob(f.ctx, retry.job.id)).status, "COMPLETED");
});

test("a strategy naming research it was not given is not saved; its usage is still metered", async () => {
  await reset();
  await saveApprovedStrategy("Keep me");
  ai.behavior = async () => ({ data: { ...STRATEGY, evidence_chain: "Need: GW-249 proves it." }, model: "test-model", usage: USAGE });
  const { job } = await start();
  const out = await s.runStrategyJob(f.ctx, job.id);
  assert.equal(out.failure_code, "EVIDENCE_CHAIN");
  assert.match(out.error, /GW-249/);
  assert.equal((await fresh()).content.strategy.primary_case, "Keep me");
  const row = await jobRow(job.id);
  assert.equal(row.result.input_tokens, USAGE.input_tokens, "usage recorded on the failed job");
  assert.equal((await aiRuns()).filter((r) => r.task === "strategy").at(-1).status, "COMPLETE");
});

test("a job whose inputs change while it runs does not overwrite the newer strategy", async () => {
  await reset();
  await saveApprovedStrategy("Written for the new program");
  const { job } = await start();
  // While the AI is generating, the user changes the funder details.
  ai.behavior = async () => {
    const a = await fresh();
    await s.handle(f.ctx, { action: "save_application", application_id: a.id, revision: a.revision, application: { funder_name: "A different funder" } });
    return { data: STRATEGY, model: "test-model", usage: USAGE };
  };
  const out = await s.runStrategyJob(f.ctx, job.id);
  assert.equal(out.failure_code, "STALE_INPUTS");
  const a = await fresh();
  assert.equal(a.content.funder_name, "A different funder");
  assert.equal(a.content.strategy.primary_case, "Written for the new program");
  // A change that does not affect strategy (the deadline) does not block saving.
  await reset();
  const second = await start();
  ai.behavior = async () => {
    const x = await fresh();
    await s.handle(f.ctx, { action: "save_application", application_id: x.id, revision: x.revision, application: { deadline: "2026-12-01" } });
    return { data: { ...STRATEGY, primary_case: "Fresh" }, model: "test-model", usage: USAGE };
  };
  assert.equal((await s.runStrategyJob(f.ctx, second.job.id)).status, "COMPLETED");
  const b = await fresh();
  assert.equal(b.content.strategy.primary_case, "Fresh");
  assert.equal(b.content.deadline, "2026-12-01");
  // Inputs changed between queueing and starting.
  await reset();
  const third = await start();
  const x = await fresh();
  await s.handle(f.ctx, { action: "save_application", application_id: x.id, revision: x.revision, application: { funder_name: "Third funder" } });
  assert.equal((await s.runStrategyJob(f.ctx, third.job.id)).failure_code, "STALE_INPUTS");
});

test("a job that outlives its lease fails cleanly and its late result is discarded", async () => {
  await reset();
  await saveApprovedStrategy("Stable");
  const { job } = await start();
  let finishedLate;
  ai.behavior = async () => {
    // Simulate the platform ending the worker: the lease expires first.
    await f.pg.query("update gf_strategy_jobs set lease_until=now()-interval '1 second' where id=$1", [job.id]);
    const polled = await status();
    assert.equal(polled.status, "FAILED");
    assert.equal(polled.failure_code, "TIMEOUT");
    assert.match(polled.error, /time limit/);
    return { data: { ...STRATEGY, primary_case: "Late" }, model: "test-model", usage: USAGE };
  };
  const out = await s.runStrategyJob(f.ctx, job.id);
  finishedLate = await jobRow(job.id);
  assert.equal(finishedLate.status, "FAILED", "an expired job stays failed");
  assert.equal(finishedLate.failure_code, "TIMEOUT");
  assert.equal(out.failure_code, "EXPIRED");
  assert.equal((await fresh()).content.strategy.primary_case, "Stable", "the late result is discarded, not saved");
  // A queued job that never starts also fails and can be retried.
  await reset();
  const q = await start();
  await f.pg.query("update gf_strategy_jobs set created_at=now()-interval '11 minutes' where id=$1", [q.job.id]);
  assert.equal((await status()).failure_code, "NOT_STARTED");
  assert.equal((await start()).created, true);
  assert.equal(STRATEGY_LEASE_OK(), true);
});
function STRATEGY_LEASE_OK() {
  const { STRATEGY_LEASE_SECONDS } = require("../netlify/lib/grant-factory/service");
  return STRATEGY_LEASE_SECONDS >= 180 && STRATEGY_LEASE_SECONDS < 900 && AI.TASK_TIMEOUT_MS.strategy / 1000 < STRATEGY_LEASE_SECONDS;
}

test("a late worker cannot save over a strategy after its job expired", async () => {
  await reset();
  await saveApprovedStrategy("Current");
  const { job } = await start();
  ai.behavior = async () => {
    await f.pg.query("update gf_strategy_jobs set lease_until=now()-interval '1 second' where id=$1", [job.id]);
    await status(); // expires it
    // Someone else edits the application in the meantime.
    const a = await fresh();
    await s.handle(f.ctx, { action: "save_application", application_id: a.id, revision: a.revision, application: { funder_name: "Edited meanwhile" } });
    return { data: { ...STRATEGY, primary_case: "Late" }, model: "test-model", usage: USAGE };
  };
  await s.runStrategyJob(f.ctx, job.id);
  assert.equal((await fresh()).content.strategy.primary_case, "Current");
});

test("abandoned AI run records are marked failed; completed usage is never changed", async () => {
  await reset();
  await f.pg.query(`insert into gf_ai_runs(org_id,actor_id,task,status,created_at) values
    ($1,$2,'strategy','RUNNING',now()-interval '20 minutes'),
    ($1,$2,'write','RUNNING',now()-interval '1 minute')`, [f.ORG, f.OWNER]);
  await f.pg.query(`insert into gf_ai_runs(org_id,actor_id,task,status,input_tokens,output_tokens,created_at,completed_at) values
    ($1,$2,'audit','COMPLETE',111,22,now()-interval '2 hours',now()-interval '2 hours')`, [f.ORG, f.OWNER]);
  await f.pg.query(`insert into gf_ai_runs(org_id,actor_id,task,status,created_at) values ($1,$2,'strategy','RUNNING',now()-interval '1 hour')`, [f.OTHER, f.OUTSIDER]);
  await start();
  const rows = (await f.pg.query("select org_id,task,status,input_tokens,error,created_at from gf_ai_runs order by created_at")).rows;
  const old = rows.find((r) => r.org_id === f.ORG && r.task === "strategy" && r.error?.startsWith("Abandoned"));
  assert.ok(old && old.status === "FAILED");
  assert.equal(rows.find((r) => r.task === "write" && r.org_id === f.ORG).status, "RUNNING", "a recent run is left alone");
  const audit = rows.find((r) => r.task === "audit" && r.input_tokens === 111);
  assert.equal(audit.status, "COMPLETE");
  assert.equal(rows.find((r) => r.org_id === f.OTHER).status, "RUNNING", "another organization's records are untouched");
});

test("organization isolation: another workspace cannot see, start or run this workspace's job", async () => {
  await reset();
  const { job } = await start();
  // Other organization's member, own workspace: sees nothing.
  assert.equal((await s.handle(f.otherCtx, { action: "strategy_status", application_id: app.id })).job, null);
  await assert.rejects(s.handle(f.otherCtx, { action: "strategy", application_id: app.id, revision: 1 }), (e) => e.status === 404);
  // Forged job id or another workspace's job cannot be claimed.
  assert.equal((await s.runStrategyJob(f.otherCtx, job.id)).claimed, false);
  assert.equal((await s.runStrategyJob(f.ctx, C.randomUUID())).claimed, false);
  assert.equal((await jobRow(job.id)).status, "QUEUED");
  // A non-member presenting this workspace is refused by the database.
  const intruder = { org_id: f.ORG, user_id: f.OUTSIDER, role: "OWNER" };
  await assert.rejects(s.runStrategyJob(intruder, job.id), /Membership required/);
  await assert.rejects(s.handle(intruder, { action: "strategy_status", application_id: app.id }), /Membership required/);
  assert.equal((await jobRow(job.id)).status, "QUEUED");
});

test("unauthenticated requests are refused by both functions", async () => {
  const repo = repository({ SUPABASE_URL: "https://test.invalid", SUPABASE_SERVICE_ROLE_KEY: "k", SUPABASE_PUBLISHABLE_KEY: "p" }, async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "" }));
  const body = JSON.stringify({ action: "strategy", application_id: app.id });
  const r1 = await gfHandler({ repo, ai, dispatch: null })({ httpMethod: "POST", headers: {}, body });
  assert.equal(r1.statusCode, 401);
  const r2 = await gfHandler({ repo, ai, dispatch: null })({ httpMethod: "POST", headers: { authorization: "Bearer expired" }, body });
  assert.equal(r2.statusCode, 401);
  const before = ai.calls;
  const r3 = await bgHandler({ repo, ai })({ httpMethod: "POST", headers: {}, body: JSON.stringify({ org_id: f.ORG, job_id: C.randomUUID() }) });
  assert.equal(r3.statusCode, 401);
  assert.equal(ai.calls, before);
});

test("the background function authenticates, then runs the job", async () => {
  await reset();
  const { job } = await start();
  const repo = Object.create(f.real);
  repo.context = async (event, org) => { assert.equal(event.headers.authorization, "Bearer user"); assert.equal(org, f.ORG); return f.ctx; };
  const r = await bgHandler({ repo, ai })({ httpMethod: "POST", headers: { authorization: "Bearer user" }, body: JSON.stringify({ org_id: f.ORG, job_id: job.id }) });
  assert.equal(r.statusCode, 202);
  assert.equal((await jobRow(job.id)).status, "COMPLETED");
});

test("the dispatcher calls this deployment's worker with the caller's own session", async () => {
  let seen;
  const d = strategyDispatcher({ rawUrl: "https://deploy-preview-9--site.netlify.app/.netlify/functions/grant-factory", headers: { authorization: "Bearer abc", host: "evil.example" } },
    async (url, init) => { seen = { url, init }; return { ok: true, status: 202 }; });
  await d({ org_id: f.ORG }, { id: "job-1" });
  assert.equal(seen.url, "https://deploy-preview-9--site.netlify.app/.netlify/functions/grant-factory-strategy-background");
  assert.equal(seen.init.headers.Authorization, "Bearer abc");
  assert.deepEqual(JSON.parse(seen.init.body), { org_id: f.ORG, job_id: "job-1" });
  assert.equal(strategyDispatcher({ rawUrl: "https://x.netlify.app/f", headers: {} }), null, "no session, no dispatch");
  const failing = strategyDispatcher({ rawUrl: "https://x.netlify.app/f", headers: { authorization: "Bearer a" } }, async () => ({ ok: false, status: 500 }));
  await assert.rejects(failing({ org_id: f.ORG }, { id: "j" }), /500/);
});

test("a failed dispatch leaves the job queued and status polling dispatches it again", async () => {
  await reset();
  let attempts = 0;
  const flaky = service(f.real, ai, { dispatch: async () => { attempts++; if (attempts === 1) throw Error("network"); } });
  const out = await flaky.handle(f.ctx, { action: "strategy", application_id: app.id, revision: (await fresh()).revision });
  assert.equal(out.job.status, "QUEUED");
  assert.equal((await jobRow(out.job.id)).dispatched_at, null);
  await f.pg.query("update gf_strategy_jobs set created_at=now()-interval '1 minute' where id=$1", [out.job.id]);
  await flaky.handle(f.ctx, { action: "strategy_status", application_id: app.id });
  assert.equal(attempts, 2);
  assert.ok((await jobRow(out.job.id)).dispatched_at);
});

test("startup stays lightweight and carries no job data", async () => {
  const boot = await s.handle(f.ctx, { action: "bootstrap" });
  const size = Buffer.byteLength(JSON.stringify(boot));
  assert.ok(size < 1_000_000, "bootstrap " + size);
  assert.equal(JSON.stringify(boot).includes("gf_strategy_jobs"), false);
});

test("the browser client polls the status call and reconnects when an application opens", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../assets/grant-factory.js"), "utf8");
  assert.match(src, /api\("strategy_status", \{ application_id: appId \}\)/);
  assert.match(src, /checkStrategy\(\);/);
  assert.match(src, /This usually takes a minute or two/);
  assert.equal(/await mutate\("strategy"\)/.test(src), false, "strategy no longer waits in the request");
});
