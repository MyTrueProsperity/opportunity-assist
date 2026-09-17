"use strict";
const { PGlite } = require("@electric-sql/pglite");
const fs = require("node:fs");
const path = require("node:path");
const OWNER = "11111111-1111-4111-8111-111111111111",
  MANAGER = "22222222-2222-4222-8222-222222222222",
  OUTSIDER = "33333333-3333-4333-8333-333333333333",
  ORG = "44444444-4444-4444-8444-444444444444",
  OTHER = "55555555-5555-4555-8555-555555555555";
async function createTestRepo() {
  const pg = new PGlite();
  await pg.exec(
    `create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,service_role;grant execute on function auth.uid() to authenticated,service_role;create table organizations(id uuid primary key);create table profiles(id uuid primary key,org_id uuid references organizations);create table opportunities(id uuid primary key,title text);insert into organizations values('${ORG}'),('${OTHER}');insert into profiles values('${OWNER}','${ORG}'),('${MANAGER}','${ORG}'),('${OUTSIDER}','${OTHER}');`,
  );
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../../supabase/grant-factory/202609170001_grant_factory.sql",
    ),
    "utf8",
  );
  await pg.exec(migration);
  await pg.exec(migration);
  await pg.exec(
    fs.readFileSync(
      path.join(
        __dirname,
        "../../supabase/grant-factory/202609170003_voice.sql",
      ),
      "utf8",
    ),
  );
  await pg.exec(
    `insert into gf_workspaces(org_id) values('${ORG}'),('${OTHER}');insert into gf_members values('${ORG}','${OWNER}','OWNER'),('${ORG}','${MANAGER}','GRANT_MANAGER'),('${OTHER}','${OUTSIDER}','OWNER');`,
  );
  const safe = (k) => {
    if (!/^[a-z_]+$/.test(k)) throw Error("Unsafe identifier");
    return '"' + k + '"';
  };
  function where(params, args) {
    return Object.entries(params)
      .filter(([k]) => !["select", "order", "limit"].includes(k))
      .map(([k, v]) => {
        const [op, ...rest] = String(v).split(".");
        if (op !== "eq") throw Error("Unsupported test filter");
        args.push(rest.join("."));
        return safe(k) + "=$" + args.length;
      })
      .join(" and ");
  }
  const db = {
    async select(table, p = {}) {
      const args = [];
      const condition = where(p, args);
      const fields = p.select ? p.select.split(",").map(safe).join(",") : "*";
      let sql =
        "select " +
        fields +
        " from " +
        safe(table) +
        (condition ? " where " + condition : "");
      if (p.order) {
        const [key, dir] = p.order.split(".");
        sql += " order by " + safe(key) + (dir === "desc" ? " desc" : " asc");
      }
      if (p.limit) sql += " limit " + Number(p.limit);
      return (await pg.query(sql, args)).rows;
    },
    async all(table, p = {}) {
      return this.select(table, p);
    },
    async patch(table, p, values) {
      const keys = Object.keys(values);
      const args = Object.values(values);
      const condition = where(p, args);
      return (
        await pg.query(
          "update " +
            safe(table) +
            " set " +
            keys.map((k, i) => safe(k) + "=$" + (i + 1)).join(",") +
            " where " +
            condition +
            " returning *",
          args,
        )
      ).rows;
    },
    async rpc(name, args) {
      const r = await pg.query(
        "select " +
          safe(name) +
          "(" +
          Object.keys(args)
            .map((k, i) => safe(k) + "=> $" + (i + 1))
            .join(",") +
          ") result",
        Object.values(args).map((v) =>
          v && typeof v === "object" ? JSON.stringify(v) : v,
        ),
      );
      return r.rows[0].result;
    },
  };
  const { repository } = require("../../netlify/lib/grant-factory/repository");
  const storage = new Map();
  const repo = repository(
    {
      SUPABASE_URL: "https://test.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "test",
      SUPABASE_PUBLISHABLE_KEY: "public",
    },
    async () => {
      throw Error("Unexpected network");
    },
  );
  repo.db = db;
  // Bind the same repository semantics to the in-process PostgreSQL test adapter.
  const flatten = (r) => ({
    ...r.content,
    id: r.id,
    revision: r.revision,
    updated_at: r.updated_at,
  });
  repo.brain = async (ctx) => {
    const [w] = await db.select("gf_workspaces", {
      org_id: "eq." + ctx.org_id,
    });
    return {
      revision: w.brain_revision,
      voice: w.voice,
      facts: (await db.all("gf_facts", { org_id: "eq." + ctx.org_id })).map(
        flatten,
      ),
      programs: (
        await db.all("gf_programs", { org_id: "eq." + ctx.org_id })
      ).map(flatten),
      documents: (
        await db.all("gf_documents", { org_id: "eq." + ctx.org_id })
      ).map(flatten),
    };
  };
  repo.writeBrain = (ctx, b, changes) =>
    db.rpc("gf_write_brain", {
      p_org: ctx.org_id,
      p_actor: ctx.user_id,
      p_expected: b.revision,
      p_changes: changes,
    });
  repo.app = async (ctx, id) => {
    const [row] = await db.select("gf_applications", {
      org_id: "eq." + ctx.org_id,
      id: "eq." + id,
    });
    if (!row)
      throw Object.assign(Error("Application not found"), { status: 404 });
    return {
      ...row,
      questions: (
        await db.select("gf_questions", {
          org_id: "eq." + ctx.org_id,
          application_id: "eq." + id,
        })
      )
        .sort((a, b) => a.position - b.position)
        .map((r) => r.content),
      answers: (
        await db.select("gf_answers", {
          org_id: "eq." + ctx.org_id,
          application_id: "eq." + id,
        })
      ).map((r) => r.content),
    };
  };
  repo.save = async (ctx, app, b, event, snapshot = null) => {
    app.revision = await db.rpc("gf_save_application", {
      p_org: ctx.org_id,
      p_actor: ctx.user_id,
      p_id: app.id,
      p_expected: app.revision,
      p_brain_revision: b.revision,
      p_record: app.content,
      p_questions: app.questions,
      p_answers: app.answers,
      p_event: event,
      p_snapshot: snapshot,
    });
    return app;
  };
  repo.storage = async (p, { method = "GET", bytes } = {}) => {
    if (method === "POST") {
      if (storage.has(p)) throw Error("Duplicate file");
      storage.set(p, Buffer.from(bytes));
      return true;
    }
    if (!storage.has(p)) throw Error("No file");
    return storage.get(p);
  };
  repo.run = async (ctx, task, fn) => {
    const run = await db.rpc("gf_begin_ai_run", {
      p_org: ctx.org_id,
      p_actor: ctx.user_id,
      p_task: task,
    });
    const result = await fn();
    await db.patch("gf_ai_runs", { id: "eq." + run }, { status: "COMPLETE" });
    return result.data;
  };
  repo.listApps = async (ctx) =>
    (await db.select("gf_applications", { org_id: "eq." + ctx.org_id })).map(
      flatten,
    );
  repo.context = async (event, requestedOrg) => {
    if (event.headers?.authorization !== "Bearer test")
      throw Object.assign(Error("Sign in"), { status: 401 });
    const memberships = await db.select("gf_members", {
      user_id: "eq." + OWNER,
    });
    const member = memberships.find((m) => m.org_id === (requestedOrg || ORG));
    if (!member)
      throw Object.assign(Error("No Grant Factory access"), { status: 403 });
    return {
      org_id: member.org_id,
      user_id: OWNER,
      role: member.role,
      workspaces: memberships.map((m) => ({
        org_id: m.org_id,
        role: m.role,
        name:
          m.org_id === ORG ? "Institute preview" : "Second workspace preview",
      })),
    };
  };
  return {
    pg,
    repo,
    storage,
    owner: { org_id: ORG, user_id: OWNER, role: "OWNER" },
    manager: { org_id: ORG, user_id: MANAGER, role: "GRANT_MANAGER" },
    outsider: { org_id: OTHER, user_id: OUTSIDER, role: "OWNER" },
  };
}
module.exports = { createTestRepo, OWNER, MANAGER, OUTSIDER, ORG, OTHER };
