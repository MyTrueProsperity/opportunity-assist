"use strict";
const { createDb } = require("../source-intelligence/db");
const { Fault, fail, id, visible, authorizedFacts, factBlockers } = require("./core");
const { researchFacts, researchSummary, researchRef, browserRecord } = require("./research");
const flatten = (r) => ({
  ...r.content,
  id: r.id,
  revision: r.revision,
  updated_at: r.updated_at,
});
// Documents in the everyday brain are summaries without extracted text.
// Saving one would erase its text, so every document write must carry blocks
// loaded through repo.document(). This check fails closed before any write.
function requireDocumentText(changes) {
  for (const c of changes || [])
    if (c.table === "gf_documents" && !Array.isArray(c.content?.blocks))
      fail("This document's text was not loaded before saving. Nothing was changed. Reopen the document and try again.", 500);
}
// Browser copies only. The server keeps full research records for drafting,
// auditing and claim rules; nothing stored is changed.
// A research fact is sent only as a lightweight reference (researchRef), and
// only when the current application actually cites it. Everything else is
// fetched on demand through the research_* actions.
function browserFact(f) {
  if (!f.research) return f;
  const { notes, research, ...rest } = f;
  return { ...rest, research: { package_version: research.package_version, record_id: research.record_id } };
}
// Kept for callers that need a whole browser-safe bundle (tests, tools).
function browserResearch(research) {
  if (!research) return research;
  return { ...research, records: (research.records || []).map(browserRecord) };
}
// `db` is injectable so tests can run the real repository against an
// in-process database; production always uses the Supabase REST client.
function repository(env = process.env, fetcher = fetch, db = createDb(env, fetcher)) {
  const base = env.SUPABASE_URL.replace(/\/$/, "");
  const headers = (token) => ({
    apikey: token
      ? env.SUPABASE_PUBLISHABLE_KEY
      : env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + (token || env.SUPABASE_SERVICE_ROLE_KEY),
  });
  return {
    db,
    env,
    async context(event, requestedOrg) {
      const token = String(
        event.headers?.authorization || event.headers?.Authorization || "",
      ).match(/^Bearer\s+(.+)$/i)?.[1];
      if (!token) fail("Sign in to use Grant Factory.", 401);
      const r = await fetcher(base + "/auth/v1/user", {
        headers: headers(token),
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) fail("Your session expired. Sign in again.", 401);
      const user = await r.json();
      id(user.id);
      const [profile] = await db.select(
        "profiles",
        { id: "eq." + user.id, select: "org_id" },
        token,
      );
      const memberships = await db.select("gf_members", {
        user_id: "eq." + user.id,
      });
      if (!memberships.length)
        fail(
          "Grant Factory access has not been enabled for your account.",
          403,
        );
      const selected = requestedOrg
        ? id(requestedOrg)
        : (
            memberships.find((m) => m.org_id === profile?.org_id) ||
            memberships[0]
          ).org_id;
      const member = memberships.find((m) => m.org_id === selected);
      if (!member)
        fail("You do not have Grant Factory access to this organization.", 403);
      const organizations = await db.select("organizations", {
        id: "in.(" + memberships.map((m) => m.org_id).join(",") + ")",
        select: "id,name",
      });
      return {
        org_id: selected,
        user_id: user.id,
        role: member.role,
        workspaces: memberships.map((m) => ({
          org_id: m.org_id,
          role: m.role,
          name:
            organizations.find((o) => o.id === m.org_id)?.name ||
            "Grant workspace",
        })),
      };
    },
    // The full brain includes every authorized research record and the facts
    // derived from them; strategy, drafting, audit and evidence checks use it.
    // With { research: false } (bootstrap only) research is replaced by a
    // summary RPC whose size does not grow with the number of records.
    async brain(ctx, { research: full = true } = {}) {
      const [[workspace], facts, programs, documents, research] = await Promise.all([
        db.select("gf_workspaces", { org_id: "eq." + ctx.org_id }),
        db.all("gf_facts", { org_id: "eq." + ctx.org_id }),
        db.all("gf_programs", { org_id: "eq." + ctx.org_id }),
        this.documentSummaries(ctx),
        full ? this.research(ctx) : this.researchSummary(ctx),
      ]);
      if (!workspace) fail("Grant Factory workspace is unavailable.", 503);
      const orgFacts = facts.map(flatten);
      // A derived organization fact may trace back to research facts, and its
      // draft readiness depends on them. Never compute it without them.
      if (!full && orgFacts.some(f => f.verification_status === "DERIVED")) return this.brain(ctx);
      return {
        revision: workspace.brain_revision,
        voice: workspace.voice,
        framework: workspace.framework || null,
        facts: full ? [...orgFacts, ...researchFacts(research)] : orgFacts,
        research: full ? research : null,
        research_summary: full ? researchSummary(research) : research,
        programs: programs.map(flatten),
        documents: documents.map(flatten),
      };
    },
    // Metadata for every document, without extracted text (blocks).
    async documentSummaries(ctx) {
      const rows = [];
      for (let after = null; ; ) {
        const page = await this.db.rpc("gf_document_summaries", { p_org: ctx.org_id, p_after: after, p_limit: 500 });
        rows.push(...page);
        if (page.length < 500) return rows;
        if (page.at(-1).id === after) fail("Document listing did not advance.", 502);
        after = page.at(-1).id;
      }
    },
    // One complete document, including extracted text.
    async document(ctx, documentId) {
      id(documentId);
      const [row] = await this.db.select("gf_documents", { org_id: "eq." + ctx.org_id, id: "eq." + documentId });
      if (!row) fail("Document not found", 404);
      return flatten(row);
    },
    async research(ctx) {
      return db.rpc("gf_research_bundle", { p_org: ctx.org_id, p_actor: ctx.user_id });
    },
    // Package identities and counts for the authorized, active packages only.
    async researchSummary(ctx) {
      return db.rpc("gf_research_summary", { p_org: ctx.org_id, p_actor: ctx.user_id });
    },
    async researchSearch(ctx, query, offset = 0) {
      return db.rpc("gf_research_search", { p_org: ctx.org_id, p_actor: ctx.user_id, p_query: query, p_offset: offset });
    },
    async researchDocument(ctx, version) {
      return db.rpc("gf_research_document", { p_org: ctx.org_id, p_actor: ctx.user_id, p_package: version });
    },
    async app(ctx, appId) {
      id(appId);
      const [row] = await db.select("gf_applications", {
        org_id: "eq." + ctx.org_id,
        id: "eq." + appId,
      });
      if (!row) fail("Application not found.", 404);
      const [questions, answers] = await Promise.all([
        db.all("gf_questions", {
          org_id: "eq." + ctx.org_id,
          application_id: "eq." + appId,
        }),
        db.all("gf_answers", {
          org_id: "eq." + ctx.org_id,
          application_id: "eq." + appId,
        }),
      ]);
      return {
        ...row,
        questions: questions
          .sort((a, b) => a.position - b.position)
          .map((q) => q.content),
        answers: answers.map((a) => a.content),
      };
    },
    async save(ctx, app, brain, event, snapshot = null) {
      const revision = await db.rpc("gf_save_application", {
        p_org: ctx.org_id,
        p_actor: ctx.user_id,
        p_id: app.id,
        p_expected: app.revision,
        p_brain_revision: brain.revision,
        p_record: app.content,
        p_questions: app.questions,
        p_answers: app.answers,
        p_event: event,
        p_snapshot: snapshot,
      });
      app.revision = revision;
      return app;
    },
    async writeBrain(ctx, brain, changes) {
      requireDocumentText(changes);
      return db.rpc("gf_write_brain", {
        p_org: ctx.org_id,
        p_actor: ctx.user_id,
        p_expected: brain.revision,
        p_changes: changes,
      });
    },
    // Background strategy jobs (supabase/grant-factory/*_strategy_jobs.sql).
    // Every call is scoped to the caller's workspace and re-checks membership.
    get strategyJobs() {
      const db = this.db;
      return {
      enqueue: (ctx, appId, inputHash, appRevision, brainRevision) => db.rpc("gf_strategy_job_enqueue", {
        p_org: ctx.org_id, p_actor: ctx.user_id, p_app: id(appId), p_input_hash: inputHash,
        p_app_revision: appRevision, p_brain_revision: brainRevision,
      }),
      claim: (ctx, jobId, leaseSeconds) => db.rpc("gf_strategy_job_claim", { p_org: ctx.org_id, p_actor: ctx.user_id, p_job: id(jobId), p_lease_seconds: leaseSeconds }),
      finish: (ctx, job, status, failureCode, error, result) => db.rpc("gf_strategy_job_finish", {
        p_org: ctx.org_id, p_job: job.id, p_token: job.lease_token, p_status: status,
        p_failure_code: failureCode || null, p_error: error || null, p_result: result || {},
      }),
      hold: (ctx, job) => db.rpc("gf_strategy_job_hold", { p_org: ctx.org_id, p_job: job.id, p_token: job.lease_token }),
      status: (ctx, appId) => db.rpc("gf_strategy_job_status", { p_org: ctx.org_id, p_actor: ctx.user_id, p_app: id(appId) }),
      dispatched: (ctx, jobId) => db.rpc("gf_strategy_job_dispatched", { p_org: ctx.org_id, p_job: id(jobId) }),
      };
    },
    async listApps(ctx) {
      return (await db.all("gf_applications", { org_id: "eq." + ctx.org_id }))
        .map(flatten)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    },
    async storage(path, { method = "GET", bytes, mime } = {}) {
      if (!/^[0-9a-f-]+\/[0-9a-f-]+\/[a-zA-Z0-9_.-]+$/.test(path))
        fail("Invalid storage path");
      const r = await fetcher(
        base + "/storage/v1/object/grant-factory/" + path,
        {
          method,
          headers: { ...headers(), ...(mime ? { "Content-Type": mime } : {}) },
          ...(bytes ? { body: bytes } : {}),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!r.ok)
        throw new Fault(
          502,
          "Private document storage is unavailable. Check the Grant Factory bucket configuration.",
        );
      return method === "GET" ? Buffer.from(await r.arrayBuffer()) : true;
    },
    async run(ctx, task, fn) {
      const runId = await db.rpc("gf_begin_ai_run", {
        p_org: ctx.org_id,
        p_actor: ctx.user_id,
        p_task: task,
      });
      let result;
      try {
        result = await fn();
        await db.patch(
          "gf_ai_runs",
          { id: "eq." + runId, org_id: "eq." + ctx.org_id },
          {
            status: "COMPLETE",
            model: result.model,
            input_tokens: result.usage?.input_tokens || 0,
            output_tokens: result.usage?.output_tokens || 0,
            completed_at: new Date().toISOString(),
          },
        );
        return result.data;
      } catch (e) {
        await db
          .patch(
            "gf_ai_runs",
            { id: "eq." + runId, org_id: "eq." + ctx.org_id },
            {
              status: "FAILED",
              error: String(e.message).slice(0, 500),
              completed_at: new Date().toISOString(),
              // A response the provider returned and we rejected (output
              // limit, invalid structure) still cost tokens; meter it.
              ...(e.usage ? {
                model: e.model || null,
                input_tokens: e.usage.input_tokens ?? null,
                output_tokens: e.usage.output_tokens ?? null,
              } : {}),
            },
          )
          .catch(() => {});
        throw e;
      }
    },
    // What the browser receives. Organization facts are complete; research is
    // a summary plus references for research facts the given application
    // cites (so its answers and eligibility reviews can show their evidence).
    publicBrain(brain, ctx, applicationId, app = null) {
      const ready = new Set(authorizedFacts(brain, applicationId).map(f => f.id));
      const status = (f) => {
        const blockers = ready.has(f.id) ? [] : factBlockers(f, brain, applicationId);
        return { draft_ready: ready.has(f.id), draft_blockers: ready.has(f.id) ? [] : blockers.length ? blockers : ["The underlying evidence needs review before this fact can be used."] };
      };
      const cited = app ? JSON.stringify(app) : "";
      const { research, research_summary, ...rest } = brain;
      return {
        ...rest,
        facts: brain.facts.filter((f) => !f.research && visible(f, ctx.role)).map(f => ({ ...f, ...status(f) })),
        research: research_summary || researchSummary(research),
        research_refs: cited
          ? brain.facts.filter(f => f.research && visible(f, ctx.role) && cited.includes(f.id)).map(f => researchRef(f, ready.has(f.id), status(f).draft_blockers))
          : [],
        documents: brain.documents
          .filter((d) => visible(d, ctx.role))
          .map(({ blocks, ...d }) => d),
      };
    },
  };
}
module.exports = { requireDocumentText, browserFact, browserResearch, repository, flatten };
