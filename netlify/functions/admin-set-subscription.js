// netlify/functions/admin-set-subscription.js
//
// Lets an admin-flagged user activate, change, or deactivate any
// organization's subscription from the app's Admin view, instead of running
// SQL by hand each time. This is what makes the Admin nav item a real
// "backdoor" rather than a one-time fix: it's reusable for comping any
// organization (a founding-cohort member, a partner, MTP's own account),
// not just a single hardcoded exemption.
//
// POST body: { org_id, status, plan }   status: inactive | active | past_due | canceled
// Header:    Authorization: Bearer <supabase access token>
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_PUBLISHABLE_KEY    to verify the caller's session
//   SUPABASE_SERVICE_ROLE_KEY   required -- this function writes subscriptions,
//                                which the client can only ever read, and reads
//                                the admins table to authorize the caller.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const VALID_STATUSES = ["inactive", "active", "past_due", "canceled"];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_KEY) {
    console.error("admin-set-subscription misconfigured: missing SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, or SUPABASE_SERVICE_ROLE_KEY.");
    return json(500, { error: "Server misconfigured." });
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
  const orgId = body.org_id;
  const status = body.status;
  const plan = body.plan || null;
  if (!orgId || !VALID_STATUSES.includes(status)) {
    return json(400, { error: "org_id and a valid status (inactive, active, past_due, canceled) are required." });
  }

  try {
    // 1. Verify the caller and confirm they're an admin. Uses the caller's own
    // token -- the admins table is readable by a user checking their own row,
    // so this doesn't need the service role key.
    const user = await sbAuthGetUser(token);
    if (!user) return json(401, { error: "Invalid or expired session." });

    const adminRow = await sbSelectOne("admins", { profile_id: "eq." + user.id, select: "profile_id" }, token);
    if (!adminRow) return json(403, { error: "Not authorized." });

    // 2. Privileged write -- this is the one place besides the Stripe webhook
    // that's allowed to touch subscriptions, and only because step 1 passed.
    await sbUpsert(
      "subscriptions",
      [{ org_id: orgId, status, plan, updated_at: new Date().toISOString() }],
      "org_id",
      SERVICE_KEY
    );

    return json(200, { ok: true });
  } catch (err) {
    console.error("admin-set-subscription error:", err);
    return json(500, { error: err.message || "Update failed." });
  }
};

/* ---------- Supabase REST helpers ---------- */

async function sbAuthGetUser(token) {
  const r = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token } });
  if (!r.ok) return null;
  return r.json();
}
async function sbSelectOne(table, params, token) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + qs, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error(table + " select failed: " + (await r.text()));
  const rows = await r.json();
  return rows[0] || null;
}
async function sbUpsert(table, rows, onConflict, serviceKey) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?on_conflict=" + onConflict, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(table + " upsert failed: " + (await r.text()));
}

function json(statusCode, obj) {
  return { statusCode, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body: JSON.stringify(obj) };
}
