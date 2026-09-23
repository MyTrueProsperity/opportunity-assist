"use strict";
const { createDb } = require("../source-intelligence/db");
const { Fault, fail, id, visible, authorizedFacts, factBlockers } = require("./core");
const { researchFacts } = require("./research");
const flatten = (r) => ({
  ...r.content,
  id: r.id,
  revision: r.revision,
  updated_at: r.updated_at,
});
function repository(env = process.env, fetcher = fetch) {
  const db = createDb(env, fetcher);
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
    async brain(ctx) {
      const [[workspace], facts, programs, documents, research] = await Promise.all([
        db.select("gf_workspaces", { org_id: "eq." + ctx.org_id }),
        db.all("gf_facts", { org_id: "eq." + ctx.org_id }),
        db.all("gf_programs", { org_id: "eq." + ctx.org_id }),
        db.all("gf_documents", { org_id: "eq." + ctx.org_id }),
        this.research(ctx),
      ]);
      if (!workspace) fail("Grant Factory workspace is unavailable.", 503);
      return {
        revision: workspace.brain_revision,
        voice: workspace.voice,
        facts: [...facts.map(flatten), ...researchFacts(research)],
        research,
        programs: programs.map(flatten),
        documents: documents.map(flatten),
      };
    },
    async research(ctx) {
      return db.rpc("gf_research_bundle", { p_org: ctx.org_id, p_actor: ctx.user_id });
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
      return db.rpc("gf_write_brain", {
        p_org: ctx.org_id,
        p_actor: ctx.user_id,
        p_expected: brain.revision,
        p_changes: changes,
      });
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
            },
          )
          .catch(() => {});
        throw e;
      }
    },
    publicBrain(brain, ctx, applicationId) {
      const ready = new Set(authorizedFacts(brain, applicationId).map(f => f.id));
      return {
        ...brain,
        facts: brain.facts.filter((f) => visible(f, ctx.role)).map(f => {
          const blockers = ready.has(f.id) ? [] : factBlockers(f, brain, applicationId);
          return { ...f, draft_ready: ready.has(f.id), draft_blockers: ready.has(f.id) ? [] : blockers.length ? blockers : ["The underlying evidence needs review before this fact can be used."] };
        }),
        documents: brain.documents
          .filter((d) => visible(d, ctx.role))
          .map(({ blocks, ...d }) => d),
      };
    },
  };
}
module.exports = { repository, flatten };
