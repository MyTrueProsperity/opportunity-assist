// netlify/functions/request-early-access.js
//
// Captures the landing page's "Request early access" form into Supabase,
// replacing the old mailto-only link with a durable, queryable record.
// Check new rows in Supabase's Table Editor under `early_access_requests`.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   this table has no client-facing policies at
//                                all, so only the service role can write it
//                                (see docs/early-access-setup.sql).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("request-early-access misconfigured: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    return json(500, { error: "Server misconfigured." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Invalid JSON body." });
  }

  // Honeypot -- a real visitor never fills this hidden field, most bots fill everything.
  // Reply with success and drop it silently so a bot can't tell it was rejected.
  if (body.website) return json(200, { ok: true });

  const email = (body.email || "").trim();
  const name = (body.name || "").trim().slice(0, 200);
  const organization = (body.organization || "").trim().slice(0, 200);
  const message = (body.message || "").trim().slice(0, 2000);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { error: "A valid email is required." });
  }

  try {
    await sbInsert("early_access_requests", [{ name, email, organization, message }]);
    return json(200, { ok: true });
  } catch (err) {
    console.error("request-early-access insert failed:", err.message);
    return json(500, { error: "Could not save your request. Please email bill@mytrueprosperity.com directly." });
  }
};

async function sbInsert(table, rows) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + table, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(table + " insert failed: " + (await r.text()));
}

function json(statusCode, obj) {
  return { statusCode, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body: JSON.stringify(obj) };
}
