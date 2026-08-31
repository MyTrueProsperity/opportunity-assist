// netlify/functions/ai-assistant.js
//
// AI Opportunity Assistant. A context-aware Q&A endpoint grounded in the
// caller's own organization profile, pipeline, and top-scoring opportunities
// -- not a blind chatbot, and not a full tool-calling agent with live DB
// queries either (that's a bigger lift; this is deliberately the simpler
// "inject a useful slice of context" version).
//
// Gated the same way as AI Fit Scoring: requires an active subscription,
// checked server-side regardless of what the client sends.
//
// POST body: { "message": "...", "history": [{role, content}, ...] }  (history: last few turns, optional)
// Header:    Authorization: Bearer <supabase access token>
//
// Env vars required:
//   ANTHROPIC_API_KEY
//   SUPABASE_URL
//   SUPABASE_PUBLISHABLE_KEY
//   SUPABASE_SERVICE_ROLE_KEY   optional, only used for the best-effort usage log

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5-20251001";
const MAX_MESSAGE_LEN = 2000;
const MAX_HISTORY_TURNS = 10;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

exports.handler = async (event) => {
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

    const org = await sbSelectOne("organizations", { id: "eq." + profile.org_id, select: "*" }, token);
    if (!org) return json(404, { error: "Organization not found." });

    // Paywall check -- same rule as AI Fit Scoring, enforced server-side regardless of client state.
    const sub = await sbSelectOne("subscriptions", { org_id: "eq." + org.id, select: "status" }, token);
    if (!sub || sub.status !== "active") {
      return json(402, { error: "Active subscription required for the AI Assistant.", paywall: true });
    }

    // Grounding context: org profile, a pipeline summary, and the org's own
    // top-scoring opportunities. Deliberately NOT the full opportunities
    // table -- keeps the prompt small and the cost predictable.
    const [pipeline, fitScores] = await Promise.all([
      sbSelect("pipeline_items", { org_id: "eq." + org.id, select: "title,stage" }, token),
      sbSelect("fit_scores", { org_id: "eq." + org.id, select: "opportunity_id,headline_score,recommendation", order: "headline_score.desc", limit: "8" }, token),
    ]);
    let topOpps = [];
    if (fitScores.length) {
      const ids = fitScores.map((f) => f.opportunity_id);
      const opps = await sbSelect("opportunities", { id: "in.(" + ids.join(",") + ")", select: "id,title,category,geography,deadline,funding_amount_label" }, token);
      const byId = {};
      opps.forEach((o) => { byId[o.id] = o; });
      topOpps = fitScores.map((f) => Object.assign({}, byId[f.opportunity_id], { fit_score: f.headline_score, recommendation: f.recommendation })).filter((o) => o.title);
    }

    const reply = await callClaude(org, pipeline, topOpps, history, message);
    return json(200, { reply });
  } catch (err) {
    console.error("ai-assistant error:", err);
    return json(500, { error: err.message || "Assistant failed." });
  }
};

async function callClaude(org, pipeline, topOpps, history, message) {
  const stageCounts = {};
  pipeline.forEach((p) => { stageCounts[p.stage] = (stageCounts[p.stage] || 0) + 1; });

  const system =
    "You are the AI Opportunity Assistant inside Opportunity Assist, a tool that helps mission-driven organizations " +
    "(workforce development, financial capability, youth employment, VITA, CRA, community prosperity) find, score, and " +
    "pursue grants, contracts, and RFPs. Answer the user's question using ONLY the organization context provided below. " +
    "If something isn't in the context, say you don't have that information rather than guessing. Be concise and practical. " +
    "Do not use em dashes.\n\n" +
    "ORGANIZATION\nName: " + (org.name || "") + "\nService areas: " + (org.service_areas || "") + "\nPrograms: " + (org.programs || "") + "\n\n" +
    "CAPTURE PIPELINE (by stage): " + (Object.keys(stageCounts).length ? JSON.stringify(stageCounts) : "empty") + "\n\n" +
    "TOP-SCORING OPPORTUNITIES:\n" +
    (topOpps.length
      ? topOpps.map((o) => "- " + o.title + " (fit " + o.fit_score + "%, " + o.recommendation + ", " + (o.funding_amount_label || "amount unknown") + ", due " + (o.deadline || "no deadline listed") + ")").join("\n")
      : "None scored yet.");

  const messages = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_LEN) }));
  messages.push({ role: "user", content: message });

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 600, system, messages }),
  });
  if (!r.ok) throw new Error("Anthropic API error: " + (await r.text()));
  const data = await r.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");

  if (SERVICE_KEY) {
    sbInsert(
      "ai_usage_logs",
      [{ org_id: org.id, model: MODEL, opportunity_count: 0, input_tokens: (data.usage && data.usage.input_tokens) || 0, output_tokens: (data.usage && data.usage.output_tokens) || 0 }],
      SERVICE_KEY
    ).catch((err) => console.error("usage log insert failed:", err.message));
  }

  return text || "I couldn't generate a response. Please try rephrasing.";
}

/* ---------- Supabase REST helpers ---------- */

function sbHeaders(keyOrToken) {
  return { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + keyOrToken, "Content-Type": "application/json" };
}
async function sbAuthGetUser(token) {
  const r = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: sbHeaders(token) });
  if (!r.ok) return null;
  return r.json();
}
async function sbSelect(table, params, token) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + qs, { headers: sbHeaders(token) });
  if (!r.ok) throw new Error(table + " select failed: " + (await r.text()));
  return r.json();
}
async function sbSelectOne(table, params, token) {
  const rows = await sbSelect(table, params, token);
  return rows[0] || null;
}
async function sbInsert(table, rows, serviceKey) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + table, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(table + " insert failed: " + (await r.text()));
}

function json(statusCode, obj) {
  return { statusCode, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body: JSON.stringify(obj) };
}
