"use strict";
const { repository } = require("../lib/grant-factory/repository");
const { provider } = require("../lib/grant-factory/ai");
const { service } = require("../lib/grant-factory/service");
const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
function makeHandler({ repo, ai } = {}) {
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
      const result = await service(repositoryInstance, ai || provider()).handle(
        ctx,
        body,
      );
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
