"use strict";
const { repository } = require("../lib/grant-factory/repository");
const { provider } = require("../lib/grant-factory/ai");
const { service } = require("../lib/grant-factory/service");
const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
// Start the background strategy worker on this same deployment, forwarding
// the caller's session so the worker authenticates it independently.
function strategyDispatcher(event, fetcher = fetch) {
  const auth = event.headers?.authorization || event.headers?.Authorization;
  let origin = null;
  try {
    origin = event.rawUrl ? new URL(event.rawUrl).origin : null;
  } catch {}
  // rawUrl is the deployment that received this request (production or a
  // deploy preview); caller-supplied Host headers are never used.
  origin = origin || process.env.URL || null;
  if (!auth || !origin) return null;
  return async (ctx, job) => {
    const r = await fetcher(origin + "/.netlify/functions/grant-factory-strategy-background", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ org_id: ctx.org_id, job_id: job.id }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("Background worker returned " + r.status);
  };
}
function makeHandler({ repo, ai, dispatch } = {}) {
  return async (event) => {
    if (event.httpMethod !== "POST")
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: "POST required" }),
      };
    try {
      if ((event.body || "").length > 4500000)
        return {
          statusCode: 413,
          headers,
          body: JSON.stringify({
            error: "Request too large. Files must be under 3 MB.",
          }),
        };
      let body;
      try {
        body = JSON.parse(event.body || "{}");
      } catch {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Invalid request JSON" }),
        };
      }
      const repositoryInstance = repo || repository();
      const ctx = await repositoryInstance.context(event, body.org_id);
      const result = await service(repositoryInstance, ai || provider(), {
        dispatch: dispatch === undefined ? strategyDispatcher(event) : dispatch,
      }).handle(ctx, body);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    } catch (e) {
      let status = e.status || 500;
      if (/Revision conflict|Truth changed/i.test(e.message)) status = 409;
      if (/Owner approval|Membership required/i.test(e.message)) status = 403;
      if (/Daily AI run limit|already running/i.test(e.message)) status = 429;
      console.error("Grant Factory request failed", {
        status,
        message: e.message,
      });
      return {
        statusCode: status,
        headers,
        body: JSON.stringify({
          error:
            status === 500
              ? "Grant Factory could not complete the request. Check deployment configuration and try again."
              : e.message,
        }),
      };
    }
  };
}
exports.handler = makeHandler();
exports.makeHandler = makeHandler;
exports.strategyDispatcher = strategyDispatcher;
