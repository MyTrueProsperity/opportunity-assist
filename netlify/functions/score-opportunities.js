// netlify/functions/score-opportunities.js
//
// AI Fit Scoring for Opportunity Assist.
// Called on demand from app.html whenever the signed-in user's Funding Radar
// has opportunities with no current fit_scores row for the ACTIVE organization.
//
// POST body:  { "opportunity_ids": ["uuid1", "uuid2", ...] }   (max 20 per call)
// Header:     Authorization: Bearer <supabase access token>
//
// Scoring happens in three steps (see assets/matching.js):
//   1. A deterministic eligibility screen. Opportunities that are KNOWN to be
//      ineligible (passed deadline, inactive source, named geography outside
//      the organization's states, single-source competition) are recorded as
//      INELIGIBLE with their reasons and never sent to the model.
//   2. The model rates ten defined rubric factors, each MATCH / PARTIAL /
//      MISMATCH / UNKNOWN with a short reason. Missing information is UNKNOWN,
//      not a low score.
//   3. The headline score, confidence and recommendation are calculated from
//      those factors in code, so they are reproducible and auditable.
//
// The organization is the caller's active organization (profiles.org_id).
// The caller must also hold an org_memberships row for it.
//
// Env vars:
//   ANTHROPIC_API_KEY          required
//   SUPABASE_URL               required
//   SUPABASE_PUBLISHABLE_KEY   required
//   SUPABASE_SERVICE_ROLE_KEY  optional, recommended (usage log and shared ai_summary cache)

const M = require("../../assets/matching");
const MODEL = "claude-haiku-4-5-20251001";
const MAX_BATCH = 20;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(statusCode, obj) {
  return { statusCode, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body: JSON.stringify(obj) };
}

function makeHandler({ env = process.env, fetcher = (...a) => fetch(...a), today } = {}) {
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = env.SUPABASE_PUBLISHABLE_KEY;
  const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || null;
  const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;

  /* ---------- Supabase REST helpers (no SDK) ---------- */
  function sbHeaders(keyOrToken) {
    return { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + keyOrToken, "Content-Type": "application/json" };
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
  async function sbUpsert(table, rows, onConflict, token) {
    const r = await fetcher(SUPABASE_URL + "/rest/v1/" + table + "?on_conflict=" + onConflict, {
      method: "POST",
      headers: Object.assign({}, sbHeaders(token), { Prefer: "resolution=merge-duplicates" }),
      body: JSON.stringify(rows),
    });
    if (!r.ok) throw new Error(table + " upsert failed: " + (await r.text()));
    return true;
  }
  async function sbPatch(table, filter, patch, token) {
    const r = await fetcher(SUPABASE_URL + "/rest/v1/" + table + "?" + filter, { method: "PATCH", headers: sbHeaders(token), body: JSON.stringify(patch) });
    if (!r.ok) throw new Error(table + " patch failed: " + (await r.text()));
    return true;
  }
  async function sbInsert(table, rows, token) {
    const r = await fetcher(SUPABASE_URL + "/rest/v1/" + table, { method: "POST", headers: sbHeaders(token), body: JSON.stringify(rows) });
    if (!r.ok) throw new Error(table + " insert failed: " + (await r.text()));
    return true;
  }

  async function callClaude(org, opp, screen, needsSummary) {
    const factorSpec = M.FACTORS.map((f) => '{"id":"' + f.id + '","state":"MATCH|PARTIAL|MISMATCH|UNKNOWN","value":<0-100 or null>,"required":<true|false>,"reason":"<one sentence>"}').join(",");
    const summarySpec = ',"ai_summary":{"what":"...","who":"...","amount":"...","deadlines":"...","documents":"...","criteria":"...","deliverables":"...","risks":"..."}';
    const schema = '{"factors":[' + factorSpec + "]" + (needsSummary ? summarySpec : "") + "}";
    const system =
      "You rate how well a funding opportunity fits one organization, for Opportunity Assist. " +
      "Rate each rubric factor separately and honestly. Do not produce an overall score; it is calculated from your factor ratings. " +
      "Use only facts stated in the organization profile and the opportunity text. " +
      "State meanings: MATCH = the stated facts clearly fit; PARTIAL = some fit or conditional fit; MISMATCH = the stated facts show a real conflict; " +
      "UNKNOWN = the information needed to judge this factor is missing. Missing information is UNKNOWN, never MISMATCH, and UNKNOWN takes value null. " +
      "Set required=true only when the opportunity text itself says something is mandatory (for example SAM registration, a UEI, a certification, a match) " +
      "and the organization profile does not show it; otherwise required=false. " +
      "Values: MATCH 60-100, PARTIAL 30-80, MISMATCH 0-40. For risk, a higher value means lower risk. " +
      "Rubric factors: " + M.FACTORS.map((f) => f.id + ": " + f.definition).join(" ") +
      " Respond with ONLY valid JSON matching this exact shape, no prose, no markdown fences: " + schema;
    const user =
      "ORGANIZATION PROFILE\n" +
      "Name: " + (org.name || "") + "\n" +
      "Service areas: " + (org.service_areas || "(not stated)") + "\n" +
      "Target populations: " + (org.target_populations || "(not stated)") + "\n" +
      "Programs: " + (org.programs || "(not stated)") + "\n" +
      "Keywords: " + ((org.keywords || []).join(", ") || "(not stated)") + "\n" +
      "NAICS codes: " + ((org.naics_codes || []).join(", ") || "(not stated)") + "\n" +
      "Certifications: " + (org.certifications || "(not stated)") + "\n" +
      "UEI: " + (org.uei || "(not stated)") + "  SAM status: " + (org.sam_status || "(not stated)") + "\n" +
      "Past performance: " + (org.past_performance || "(not stated)") + "\n\n" +
      "OPPORTUNITY\n" +
      "Title: " + (opp.title || "") + "\n" +
      "Type/category: " + (opp.category || "(not stated)") + "\n" +
      "Geography: " + (opp.geography || "(not stated)") + "\n" +
      "Funding amount: " + (opp.funding_amount_label || opp.funding_amount || "(not stated)") + "\n" +
      "Deadline: " + (opp.deadline || "(not stated)") + "\n" +
      "Summary: " + (opp.summary || "(not stated)") + "\n" +
      "Requirements: " + (opp.requirements || "(not stated)") + "\n" +
      "Source: " + (opp.source || "") + (opp.source_url ? " (" + opp.source_url + ")" : "") + "\n\n" +
      "PRE-SCREEN: no known eligibility barrier. Information missing before scoring: " + (screen.unknowns.join(", ") || "none") + ".";

    const r = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: needsSummary ? 1600 : 1100, system, messages: [{ role: "user", content: user }] }),
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
    if (!Array.isArray(parsed.factors)) throw new Error("AI response did not include rubric factors.");
    return { data: parsed, usage: data.usage || {} };
  }

  async function scoreOne(opp, org, token) {
    const screen = M.eligibility(org, opp, today && today());
    const base = { org_id: org.id, opportunity_id: opp.id, rubric_version: M.RUBRIC_VERSION, eligibility_status: screen.status, eligibility_reasons: screen.reasons.concat(screen.unknowns.map((u) => "Unknown: " + u)), scored_at: new Date().toISOString(), source_stale: false };
    if (screen.status === "INELIGIBLE") {
      // Known barrier: record it and skip the model entirely.
      await sbUpsert("fit_scores", [{ ...base, headline_score: null, confidence: null, recommendation: "Not eligible", factors: [] }], "org_id,opportunity_id", token);
      return { opportunity_id: opp.id, headline_score: null, recommendation: "Not eligible", factors: [], eligibility_status: screen.status, eligibility_reasons: base.eligibility_reasons, confidence: null, rubric_version: M.RUBRIC_VERSION, ai_summary: opp.ai_summary || null, usage: {} };
    }
    const needsSummary = !opp.ai_summary || !Object.keys(opp.ai_summary).length;
    const ai = await callClaude(org, opp, screen, needsSummary);
    const result = M.computeHeadline(ai.data.factors);
    await sbUpsert("fit_scores", [{ ...base, headline_score: result.headline, confidence: result.confidence, recommendation: result.recommendation, factors: result.factors }], "org_id,opportunity_id", token);
    let ai_summary = opp.ai_summary || null;
    if (needsSummary && ai.data.ai_summary) {
      ai_summary = ai.data.ai_summary;
      if (SERVICE_KEY) await sbPatch("opportunities", "id=eq." + opp.id, { ai_summary }, SERVICE_KEY).catch((err) => console.error("ai_summary cache write failed:", err.message));
    }
    return { opportunity_id: opp.id, headline_score: result.headline, recommendation: result.recommendation, factors: result.factors, confidence: result.confidence, caps: result.caps, eligibility_status: screen.status, eligibility_reasons: base.eligibility_reasons, rubric_version: M.RUBRIC_VERSION, ai_summary, usage: ai.usage };
  }

  return async (event) => {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !ANTHROPIC_API_KEY)
      return json(500, { error: "Server misconfigured: missing SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, or ANTHROPIC_API_KEY." });
    const authHeader = event.headers.authorization || event.headers.Authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { error: "Missing Authorization bearer token." });
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Invalid JSON body." }); }
    const ids = Array.isArray(body.opportunity_ids) ? body.opportunity_ids.filter(Boolean).slice(0, MAX_BATCH) : [];
    if (!ids.length) return json(400, { error: "opportunity_ids is required (max " + MAX_BATCH + ")." });
    try {
      const user = await sbAuthGetUser(token);
      if (!user) return json(401, { error: "Invalid or expired session." });
      const profile = await sbSelectOne("profiles", { id: "eq." + user.id, select: "org_id" }, token);
      if (!profile || !profile.org_id) return json(400, { error: "No organization on this profile yet." });
      // The active organization must be one the user is explicitly authorized for.
      const membership = await sbSelectOne("org_memberships", { user_id: "eq." + user.id, org_id: "eq." + profile.org_id, select: "org_id" }, token);
      if (!membership) return json(403, { error: "You are not authorized for the active organization." });
      const org = await sbSelectOne("organizations", { id: "eq." + profile.org_id, select: "*" }, token);
      if (!org) return json(404, { error: "Organization not found." });
      // Paywall: the real boundary. subscriptions is read-only to the client.
      const sub = await sbSelectOne("subscriptions", { org_id: "eq." + org.id, select: "status" }, token);
      if (!sub || sub.status !== "active") return json(402, { error: "Active subscription required for AI Fit Scoring.", paywall: true });
      const opps = await sbSelect("opportunities", { id: "in.(" + ids.join(",") + ")", select: "*" }, token);
      if (!opps.length) return json(404, { error: "No matching opportunities found." });
      const scored = await Promise.all(opps.map((opp) => scoreOne(opp, org, token)));
      if (SERVICE_KEY) {
        const aiScored = scored.filter((r) => r.eligibility_status !== "INELIGIBLE");
        const totals = aiScored.reduce((acc, r) => { acc.input_tokens += r.usage.input_tokens || 0; acc.output_tokens += r.usage.output_tokens || 0; return acc; }, { input_tokens: 0, output_tokens: 0 });
        if (aiScored.length)
          sbInsert("ai_usage_logs", [{ org_id: org.id, model: MODEL, opportunity_count: aiScored.length, input_tokens: totals.input_tokens, output_tokens: totals.output_tokens }], SERVICE_KEY).catch((err) => console.error("usage log insert failed:", err.message));
      }
      const results = scored.map(({ usage, ...r }) => r);
      return json(200, { results, org_id: org.id, rubric_version: M.RUBRIC_VERSION, service_role_configured: !!SERVICE_KEY });
    } catch (err) {
      console.error("score-opportunities error:", err);
      return json(500, { error: err.message || "Scoring failed." });
    }
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
