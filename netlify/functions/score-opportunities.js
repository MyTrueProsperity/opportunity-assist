// netlify/functions/score-opportunities.js
//
// AI Fit Scoring for Opportunity Assist.
// Called on demand from app.html whenever the signed-in user's Funding Radar
// has opportunities with no fit_scores row yet for their organization.
//
// POST body:  { "opportunity_ids": ["uuid1", "uuid2", ...] }   (max 20 per call)
// Header:     Authorization: Bearer <supabase access token>
//
// Env vars:
//   ANTHROPIC_API_KEY          required
//   SUPABASE_URL               required — same value as OA_CONFIG.SUPABASE_URL in app.html
//   SUPABASE_PUBLISHABLE_KEY   required — same value as OA_CONFIG.SUPABASE_PUBLISHABLE_KEY
//   SUPABASE_SERVICE_ROLE_KEY  optional, recommended — see readme.md "AI Fit Scoring"
//                              section for what it unlocks and how to add it.
//
// Requires Node 18+ (Netlify's default runtime) for global fetch. No npm
// dependencies, in keeping with the rest of this repo.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5-20251001";
const MAX_BATCH = 20;
const FACTOR_LABELS = ["Organizational fit", "Geographic eligibility", "Capacity", "Budget range", "Risk profile"];

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
  const ids = Array.isArray(body.opportunity_ids) ? body.opportunity_ids.filter(Boolean).slice(0, MAX_BATCH) : [];
  if (!ids.length) return json(400, { error: "opportunity_ids is required (max " + MAX_BATCH + ")." });

  try {
    // 1. Verify the session and resolve the caller's organization.
    const user = await sbAuthGetUser(token);
    if (!user) return json(401, { error: "Invalid or expired session." });

    const profile = await sbSelectOne("profiles", { id: "eq." + user.id, select: "org_id" }, token);
    if (!profile || !profile.org_id) return json(400, { error: "No organization on this profile yet." });

    const org = await sbSelectOne("organizations", { id: "eq." + profile.org_id, select: "*" }, token);
    if (!org) return json(404, { error: "Organization not found." });

    // 1b. Paywall check. This is the real security boundary -- app.html also checks
    // client-side to save a round trip, but that's a UX nicety only. The subscriptions
    // table is read-only to the client (see docs/stripe-billing-setup.sql), so this can't
    // be spoofed by a signed-in user updating their own row.
    const sub = await sbSelectOne("subscriptions", { org_id: "eq." + org.id, select: "status" }, token);
    if (!sub || sub.status !== "active") {
      return json(402, { error: "Active subscription required for AI Fit Scoring.", paywall: true });
    }

    // 2. Fetch the requested opportunities (read access already granted by existing RLS).
    const opps = await sbSelect("opportunities", { id: "in.(" + ids.join(",") + ")", select: "*" }, token);
    if (!opps.length) return json(404, { error: "No matching opportunities found." });

    // 3. Score every opportunity concurrently, to stay well under the function timeout.
    const scored = await Promise.all(opps.map((opp) => scoreOne(opp, org, token)));

    // 4. Best-effort usage log. Requires the service role key; never blocks the response.
    if (SERVICE_KEY) {
      const totals = scored.reduce(
        (acc, r) => {
          acc.input_tokens += r.usage.input_tokens || 0;
          acc.output_tokens += r.usage.output_tokens || 0;
          return acc;
        },
        { input_tokens: 0, output_tokens: 0 }
      );
      sbInsert(
        "ai_usage_logs",
        [{ org_id: org.id, model: MODEL, opportunity_count: opps.length, input_tokens: totals.input_tokens, output_tokens: totals.output_tokens }],
        SERVICE_KEY
      ).catch((err) => console.error("usage log insert failed:", err.message));
    }

    const results = scored.map(({ usage, ...r }) => r);
    return json(200, { results, service_role_configured: !!SERVICE_KEY });
  } catch (err) {
    console.error("score-opportunities error:", err);
    return json(500, { error: err.message || "Scoring failed." });
  }
};

async function scoreOne(opp, org, token) {
  const needsSummary = !opp.ai_summary || !Object.keys(opp.ai_summary).length;
  const ai = await callClaude(org, opp, needsSummary);

  // Org-scoped write — allowed for the signed-in user under existing RLS,
  // the same policy the client already uses today.
  await sbUpsert(
    "fit_scores",
    [{ org_id: org.id, opportunity_id: opp.id, headline_score: ai.data.headline_score, recommendation: ai.data.recommendation, factors: ai.data.factors }],
    "org_id,opportunity_id",
    token
  );

  let ai_summary = opp.ai_summary || null;
  if (needsSummary && ai.data.ai_summary) {
    ai_summary = ai.data.ai_summary;
    // Global cache write (shared across every org) needs elevated privileges.
    // Skipped gracefully if the service role key isn't configured yet — the
    // summary still returns for this request, it just won't be cached.
    if (SERVICE_KEY) {
      await sbPatch("opportunities", "id=eq." + opp.id, { ai_summary }, SERVICE_KEY).catch((err) =>
        console.error("ai_summary cache write failed:", err.message)
      );
    }
  }

  return {
    opportunity_id: opp.id,
    headline_score: ai.data.headline_score,
    recommendation: ai.data.recommendation,
    factors: ai.data.factors,
    ai_summary,
    usage: ai.usage,
  };
}

/* ---------- Claude ---------- */

async function callClaude(org, opp, needsSummary) {
  const schema = needsSummary
    ? `{"headline_score": <0-100 integer>, "factors": [{"label": "<one of: ${FACTOR_LABELS.join(" | ")}>", "val": <0-100 integer>}, ...all five], "ai_summary": {"what": "...", "who": "...", "amount": "...", "deadlines": "...", "documents": "...", "criteria": "...", "deliverables": "...", "risks": "..."}}`
    : `{"headline_score": <0-100 integer>, "factors": [{"label": "<one of: ${FACTOR_LABELS.join(" | ")}>", "val": <0-100 integer>}, ...all five]}`;

  const system =
    "You are the fit-scoring engine for Opportunity Assist, a tool that helps mission-driven organizations " +
    "(workforce development, financial capability, youth employment, VITA, CRA, community prosperity) decide " +
    "whether a grant, contract, RFP, or procurement opportunity is worth pursuing. " +
    "Score honestly and conservatively. Do not inflate scores to be encouraging, and do not invent facts not " +
    "present in the opportunity text. Respond with ONLY valid JSON matching this exact shape, no prose, no " +
    "markdown fences: " + schema;

  const user =
    "ORGANIZATION PROFILE\n" +
    "Name: " + (org.name || "") + "\n" +
    "Service areas: " + (org.service_areas || "") + "\n" +
    "Target populations: " + (org.target_populations || "") + "\n" +
    "Programs: " + (org.programs || "") + "\n" +
    "Keywords: " + (org.keywords || []).join(", ") + "\n" +
    "UEI: " + (org.uei || "") + "  SAM status: " + (org.sam_status || "") + "\n" +
    "Past performance: " + (org.past_performance || "") + "\n\n" +
    "OPPORTUNITY\n" +
    "Title: " + (opp.title || "") + "\n" +
    "Category: " + (opp.category || "") + "\n" +
    "Geography: " + (opp.geography || "") + "\n" +
    "Funding amount: " + (opp.funding_amount_label || opp.funding_amount || "") + "\n" +
    "Deadline: " + (opp.deadline || "") + "\n" +
    "Summary: " + (opp.summary || "") + "\n" +
    "Requirements: " + (opp.requirements || "") + "\n" +
    "Source: " + (opp.source || "") + (opp.source_url ? " (" + opp.source_url + ")" : "");

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: needsSummary ? 900 : 400,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error("Anthropic API error: " + (await r.text()));
  const data = await r.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (e) {
    throw new Error("Could not parse AI response as JSON: " + text.slice(0, 200));
  }

  // Recommendation label is derived deterministically so it always matches the
  // UI's existing color thresholds (75 / 55), rather than trusting exact wording from the model.
  const score = Math.max(0, Math.min(100, Math.round(parsed.headline_score || 0)));
  parsed.headline_score = score;
  parsed.recommendation = score >= 75 ? "Strongly pursue" : score >= 55 ? "Worth reviewing" : "Probably pass";

  return { data: parsed, usage: data.usage || {} };
}

/* ---------- Supabase REST helpers (no SDK — keeps the function dependency-free) ---------- */

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
async function sbUpsert(table, rows, onConflict, token) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?on_conflict=" + onConflict, {
    method: "POST",
    headers: Object.assign({}, sbHeaders(token), { Prefer: "resolution=merge-duplicates" }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(table + " upsert failed: " + (await r.text()));
  return true;
}
async function sbPatch(table, filter, patch, token) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + filter, {
    method: "PATCH",
    headers: sbHeaders(token),
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(table + " patch failed: " + (await r.text()));
  return true;
}
async function sbInsert(table, rows, token) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + table, { method: "POST", headers: sbHeaders(token), body: JSON.stringify(rows) });
  if (!r.ok) throw new Error(table + " insert failed: " + (await r.text()));
  return true;
}

function json(statusCode, obj) {
  return { statusCode, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body: JSON.stringify(obj) };
}
