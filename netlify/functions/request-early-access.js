// netlify/functions/request-early-access.js
//
// Captures the landing page's request form into Supabase, a durable,
// queryable record. Check new rows in Supabase's Table Editor under
// `early_access_requests`.
//
// Each saved request is also emailed to NOTIFY_EMAIL (default
// bill@mytrueprosperity.com) once RESEND_API_KEY is set, so a request does
// not sit unseen in the table. A failed email never fails the request.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   this table has no client-facing policies at
//                                all, so only the service role can write it
//                                (see docs/early-access-setup.sql).
// Optional:
//   RESEND_API_KEY, EMAIL_FROM, NOTIFY_EMAIL  (see netlify/lib/notifications/email.js)

const email = require("../lib/notifications/email");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(statusCode, obj) {
  return { statusCode, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body: JSON.stringify(obj) };
}

function makeHandler({ env = process.env, fetcher = (...a) => fetch(...a) } = {}) {
  const SUPABASE_URL = env.SUPABASE_URL;
  const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  async function sbInsert(table, rows) {
    const r = await fetcher(SUPABASE_URL + "/rest/v1/" + table, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(rows),
    });
    if (!r.ok) throw new Error(table + " insert failed: " + (await r.text()));
  }

  async function notify(req) {
    const rows = [["Name", req.name || "(not given)"], ["Email", req.email], ["Organization", req.organization || "(not given)"], ["Looking for", req.message || "(not given)"]];
    const html = email.layout({
      heading: "New request from " + (req.name || req.email),
      intro: "Someone asked about Opportunity Assist on opportunityassist.com. Reply to this email to answer them directly.",
      sections: [{ title: "Request", items: rows.map(([k, v]) => ({ title: k, detail: v })) }],
    });
    const text = rows.map(([k, v]) => k + ": " + v).join("\n");
    return email.sendEmail({
      to: env.NOTIFY_EMAIL || "bill@mytrueprosperity.com",
      replyTo: req.email,
      subject: "Opportunity Assist request: " + (req.organization || req.name || req.email),
      html,
      text,
    }, { env, fetcher });
  }

  return async (event) => {
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

    // Honeypot: a real visitor never fills this hidden field, most bots fill everything.
    // Reply with success and drop it silently so a bot can't tell it was rejected.
    if (body.website) return json(200, { ok: true });

    const address = (body.email || "").trim().slice(0, 320);
    const name = (body.name || "").trim().slice(0, 200);
    const organization = (body.organization || "").trim().slice(0, 200);
    const message = (body.message || "").trim().slice(0, 2000);

    if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      return json(400, { error: "A valid email is required." });
    }

    try {
      await sbInsert("early_access_requests", [{ name, email: address, organization, message }]);
    } catch (err) {
      console.error("request-early-access insert failed:", err.message);
      return json(500, { error: "Could not save your request. Please email bill@mytrueprosperity.com directly." });
    }
    try {
      await notify({ name, email: address, organization, message });
    } catch (err) {
      console.error("request-early-access notification failed:", err.message);
    }
    return json(200, { ok: true });
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
