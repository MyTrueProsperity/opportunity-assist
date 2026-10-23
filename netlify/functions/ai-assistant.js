// netlify/functions/ai-assistant.js
//
// AI Opportunity Assistant. A context-aware Q&A endpoint grounded in the
// caller's own organization profile, Capture Pipeline, and best current leads.
// It is not a tool-calling agent with live database access; it injects a
// bounded slice of the organization's own data into the prompt.
//
// Gated the same way as AI Fit Scoring: requires an active subscription,
// checked server-side regardless of what the client sends.
//
// "Best current leads" are AI-scored opportunities that are:
//   * scored under the current rubric and not marked stale,
//   * not known ineligible (passed deadline, inactive source, other state),
//   * not passed on by this organization.
// Unscored and ineligible rows are excluded in the query itself. Postgres sorts
// NULL first on a descending sort, which previously filled the list with
// closed "Not eligible" records.
//
// POST body: { "message": "...", "history": [{role, content}, ...] }  (history: last few turns, optional)
// Header:    Authorization: Bearer <supabase access token>
//
// Env vars required:
//   ANTHROPIC_API_KEY
//   SUPABASE_URL
//   SUPABASE_PUBLISHABLE_KEY
//   SUPABASE_SERVICE_ROLE_KEY   optional, only used for the usage log

const M = require("../../assets/matching");

const MODEL = "claude-haiku-4-5-20251001";
const MAX_MESSAGE_LEN = 2000;
const MAX_HISTORY_TURNS = 10;
const TOP_LEADS = 8;
const PIPELINE_ITEMS = 15;
const CLOSED_STAGES = ["Awarded", "Not Awarded"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(statusCode, obj) {
  return { statusCode, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body: JSON.stringify(obj) };
}

function makeHandler({ env = process.env, fetcher = (...a) => fetch(...a), today = () => new Date().toISOString().slice(0, 10) } = {}) {
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = env.SUPABASE_PUBLISHABLE_KEY;
  const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || null;
  const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;

  function sbHeaders(token) {
    return { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token, "Content-Type": "application/json" };
  }
  async function sbAuthGetUser(token) {
    const r = await fetcher(SUPABASE_URL + "/auth/v1/user", { headers: sbHeaders(token) });
    if (!r.ok) return null;
    return r.json();
  }
  async function sbSelect(table, params, token) {
    const qs = new URLSearchParams(params).toString();
    const r = await fetcher(SUPABASE_URL + "/rest/v1/" + table + "?" + qs, { headers: sbHeaders(token) });
    if (!r.ok) throw new Error(table + " select failed: " + (await r.text()));
    return r.json();
  }
  async function sbSelectOne(table, params, token) {
    const rows = await sbSelect(table, params, token);
    return rows[0] || null;
  }
  async function logUsage(orgId, usage) {
    if (!SERVICE_KEY) return;
    try {
      const r = await fetcher(SUPABASE_URL + "/rest/v1/ai_usage_logs", {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify([{ org_id: orgId, model: MODEL, opportunity_count: 0, input_tokens: (usage && usage.input_tokens) || 0, output_tokens: (usage && usage.output_tokens) || 0 }]),
      });
      if (!r.ok) console.error("usage log insert failed:", await r.text());
    } catch (err) {
      console.error("usage log insert failed:", err.message);
    }
  }

  async function bestCurrentLeads(org, token, asOf) {
    const scores = await sbSelect("fit_scores", {
      org_id: "eq." + org.id,
      headline_score: "not.is.null",
      source_stale: "is.false",
      eligibility_status: "neq.INELIGIBLE",
      rubric_version: "eq." + M.RUBRIC_VERSION,
      select: "opportunity_id,headline_score,recommendation,confidence",
      order: "headline_score.desc.nullslast",
      limit: "60",
    }, token);
    if (!scores.length) return [];
    const [opps, decisions] = await Promise.all([
      sbSelect("opportunities", { id: "in.(" + scores.map((s) => s.opportunity_id).join(",") + ")", select: "id,title,category,geography,deadline,funding_amount,funding_amount_label,requirements,source_active" }, token),
      sbSelect("pursue_decisions", { org_id: "eq." + org.id, select: "opportunity_id,decision,decided_at", order: "decided_at.desc" }, token),
    ]);
    const latest = {};
    decisions.forEach((d) => { if (!latest[d.opportunity_id]) latest[d.opportunity_id] = d.decision; });
    const byId = {};
    opps.forEach((o) => { byId[o.id] = o; });
    return scores
      .map((s) => Object.assign({}, byId[s.opportunity_id], { fit_score: s.headline_score, recommendation: s.recommendation }))
      .filter((o) => o.id && latest[o.id] !== "pass" && M.eligibility(org, o, asOf).status !== "INELIGIBLE")
      .slice(0, TOP_LEADS);
  }

  async function callClaude(org, pipeline, topOpps, history, message, asOf) {
    const stageCounts = {};
    pipeline.forEach((p) => { stageCounts[p.stage] = (stageCounts[p.stage] || 0) + 1; });
    const open = pipeline
      .filter((p) => CLOSED_STAGES.indexOf(p.stage) === -1)
      .map((p) => Object.assign({}, p, { due: p.deadline || (p.opportunities && p.opportunities.deadline) || null }))
      .sort((a, b) => String(a.due || "9999").localeCompare(String(b.due || "9999")))
      .slice(0, PIPELINE_ITEMS);

    const system =
      "You are the AI Opportunity Assistant inside Opportunity Assist, a tool that helps mission-driven organizations " +
      "(workforce development, financial capability, youth employment, VITA, CRA, community prosperity) find, score, and " +
      "pursue grants, contracts, and RFPs. Answer the user's question using ONLY the organization context provided below. " +
      "If something isn't in the context, say you don't have that information rather than guessing. Many listings do not state " +
      "an award amount or a deadline; say so when it matters instead of inventing one. Be concise and practical. " +
      "Do not use em dashes.\n\n" +
      "TODAY: " + asOf + "\n\n" +
      "ORGANIZATION\nName: " + (org.name || "") + "\nService areas: " + (org.service_areas || "") + "\nTarget populations: " + (org.target_populations || "") + "\nPrograms: " + (org.programs || "") + "\n\n" +
      "CAPTURE PIPELINE (count by stage): " + (Object.keys(stageCounts).length ? JSON.stringify(stageCounts) : "empty") + "\n" +
      (open.length
        ? "Open pipeline items, nearest deadline first:\n" + open.map((p) => "- " + p.title + " (" + p.stage + ", " + (p.due ? "due " + p.due : "no deadline listed") + ")").join("\n") + "\n"
        : "") +
      "\nBEST CURRENT LEADS (AI-scored, not closed, not known ineligible, not passed on):\n" +
      (topOpps.length
        ? topOpps.map((o) => "- " + o.title + " (fit " + o.fit_score + "%, " + o.recommendation + ", " + (o.funding_amount_label || "amount not stated") + ", " + (o.deadline ? "due " + o.deadline : "no deadline listed") + ", " + (o.geography || "geography not stated") + ")").join("\n")
        : "None scored yet.");

    const messages = history
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_LEN) }));
    messages.push({ role: "user", content: message });

    const r = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 600, system, messages }),
    });
    if (!r.ok) throw new Error("Anthropic API error: " + (await r.text()));
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    // Awaited: a serverless function can be frozen as soon as it returns.
    await logUsage(org.id, data.usage);
    return text || "I couldn't generate a response. Please try rephrasing.";
  }

  return async (event) => {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !ANTHROPIC_API_KEY) {
      return json(500, { error: "Server misconfigured: missing SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, or ANTHROPIC_API_KEY." });
    }

    const authHeader = event.headers.authorization || event.headers.Authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { error: "Missing Authorization bearer token." });

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, { error: "Invalid JSON body." });
    }
    const message = (body.message || "").trim().slice(0, MAX_MESSAGE_LEN);
    if (!message) return json(400, { error: "message is required." });
    const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY_TURNS) : [];

    try {
      const user = await sbAuthGetUser(token);
      if (!user) return json(401, { error: "Invalid or expired session." });

      const profile = await sbSelectOne("profiles", { id: "eq." + user.id, select: "org_id" }, token);
      if (!profile || !profile.org_id) return json(400, { error: "No organization on this profile yet." });
      const membership = await sbSelectOne("org_memberships", { user_id: "eq." + user.id, org_id: "eq." + profile.org_id, select: "org_id" }, token);
      if (!membership) return json(403, { error: "You are not authorized for the active organization." });

      const org = await sbSelectOne("organizations", { id: "eq." + profile.org_id, select: "*" }, token);
      if (!org) return json(404, { error: "Organization not found." });

      const sub = await sbSelectOne("subscriptions", { org_id: "eq." + org.id, select: "status" }, token);
      if (!sub || sub.status !== "active") {
        return json(402, { error: "Active subscription required for the AI Assistant.", paywall: true });
      }

      const asOf = today();
      const [pipeline, topOpps] = await Promise.all([
        sbSelect("pipeline_items", { org_id: "eq." + org.id, select: "title,stage,deadline,opportunities(deadline)" }, token),
        bestCurrentLeads(org, token, asOf),
      ]);

      const reply = await callClaude(org, pipeline, topOpps, history, message, asOf);
      return json(200, { reply });
    } catch (err) {
      console.error("ai-assistant error:", err);
      return json(500, { error: err.message || "Assistant failed." });
    }
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
