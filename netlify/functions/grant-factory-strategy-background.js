"use strict";
// Background worker for Grant Factory strategy generation. Netlify runs
// "-background" functions for up to 15 minutes and answers the caller with
// 202 immediately. The caller's own session is required: the worker
// re-authenticates it and re-checks Grant Factory membership for the job's
// workspace before claiming the job, so queue-time authorization is never
// assumed. See runStrategyJob in lib/grant-factory/service.js.
const { repository } = require("../lib/grant-factory/repository");
const { provider } = require("../lib/grant-factory/ai");
const { service } = require("../lib/grant-factory/service");
function makeHandler({ repo, ai } = {}) {
  return async (event) => {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST required" };
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return { statusCode: 400, body: "Invalid request JSON" };
    }
    try {
      const repositoryInstance = repo || repository();
      const ctx = await repositoryInstance.context(event, body.org_id);
      const out = await service(repositoryInstance, ai || provider()).runStrategyJob(ctx, body.job_id);
      console.log(JSON.stringify({ event: "grant-factory-strategy-job", job: String(body.job_id || "").slice(0, 36), claimed: out.claimed, status: out.status || null, failure_code: out.failure_code || null }));
      return { statusCode: 202, body: "" };
    } catch (e) {
      console.error("Grant Factory strategy job failed", { job: String(body.job_id || "").slice(0, 36), status: e.status || 500, message: e.message });
      return { statusCode: e.status || 500, body: "" };
    }
  };
}
exports.handler = makeHandler();
exports.makeHandler = makeHandler;
