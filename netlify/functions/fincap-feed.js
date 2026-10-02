// netlify/functions/fincap-feed.js
//
// Public, read-only feed of EDITORIALLY APPROVED funding opportunities for
// NationalFinCap.org, plus a newsletter-ready export for Claude.
//
//   GET /.netlify/functions/fincap-feed?view=opportunities                JSON for the website
//   GET /.netlify/functions/fincap-feed?view=newsletter&issue=YYYY-MM-DD  JSON for an issue date
//        add &format=md for a readable export
//        optional: &repeat_within_days=14  also include deliberate deadline reminders
// netlify.toml also maps /api/fincap/opportunities and /api/fincap/newsletter
// here, but callers use the function path, which does not depend on redirects.
//
// Privacy boundary: this function never reads a private table. It calls two
// service_role-only database functions that read the approved snapshot, and it
// re-projects every row through PUBLIC_FIELDS so a future database change
// cannot widen the output by accident. Responses are CDN-cached, which keeps
// public traffic from becoming Supabase traffic.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server-side only).

const PUBLIC_FIELDS = [
  "id", "title", "funder", "source_url", "amount_text", "deadline", "deadline_tz", "deadline_kind",
  "deadline_verified", "eligible_applicants", "geography", "program_areas", "summary",
  "last_verified_on", "status", "recheck_pending", "published_at", "updated_at",
];
const NEWSLETTER_FIELDS = PUBLIC_FIELDS.filter((f) => !["status", "recheck_pending", "published_at", "updated_at"].includes(f))
  .concat(["include_reason", "deadline_flag"]);

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
const CACHE = "public, max-age=120, s-maxage=300, stale-while-revalidate=600";

function pick(row, fields) {
  const out = {};
  for (const f of fields) out[f] = row && row[f] !== undefined ? row[f] : null;
  return out;
}
const isHttpUrl = (u) => typeof u === "string" && /^https?:\/\/[^\s]+$/i.test(u);
function clean(item) {
  if (!isHttpUrl(item.source_url)) item.source_url = null;
  return item;
}
const projectPublic = (row) => clean(pick(row, PUBLIC_FIELDS));
const projectNewsletter = (row) => clean(pick(row, NEWSLETTER_FIELDS));

function fmtDeadline(i) {
  if (i.deadline_kind === "fixed" && i.deadline) {
    const d = new Date(i.deadline + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    return `${d} (${String(i.deadline_tz || "America/New_York").replace("America/", "").replace("_", " ")} time)`;
  }
  return i.deadline_kind === "rolling" ? "Rolling (no fixed deadline)" : "Deadline not confirmed";
}
const REASON = { new: "New", updated: "Updated", deadline_reminder: "Deadline reminder" };

function toMarkdown(exp) {
  const lines = [`# Funding opportunities for the ${exp.issue_date} issue`, ""];
  lines.push("Source: approved opportunities on NationalFinCap.org. Verify details at the funder link before sending.", "");
  if (!exp.items.length) lines.push("_No new or updated approved opportunities for this issue._", "");
  for (const i of exp.items) {
    lines.push(`## ${i.title} (${REASON[i.include_reason] || i.include_reason})`);
    lines.push(`- Funder: ${i.funder}`);
    if (i.amount_text) lines.push(`- Amount: ${i.amount_text}`);
    lines.push(`- Deadline: ${fmtDeadline(i)}`);
    if (i.deadline_flag) lines.push(`- Check: ${i.deadline_flag}`);
    if (i.eligible_applicants) lines.push(`- Who can apply: ${i.eligible_applicants}`);
    if (i.geography) lines.push(`- Where: ${i.geography}`);
    if (i.program_areas && i.program_areas.length) lines.push(`- Program areas: ${i.program_areas.join(", ")}`);
    lines.push(`- Last verified: ${i.last_verified_on}`);
    if (i.source_url) lines.push(`- Funder link: ${i.source_url}`);
    lines.push("", i.summary, "");
  }
  if (exp.held_for_recheck.length) {
    lines.push("## Held for re-verification (not included)", "");
    for (const h of exp.held_for_recheck) lines.push(`- ${h.title}`);
    lines.push("");
  }
  if (exp.previously_included_count) lines.push(`_${exp.previously_included_count} open opportunity(ies) already ran in an earlier issue and were left out._`, "");
  return lines.join("\n");
}

async function rpc(deps, fn, body) {
  const r = await deps.fetch(`${deps.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: deps.key, Authorization: `Bearer ${deps.key}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`database ${r.status}`);
  return r.json();
}

function reply(statusCode, body, extra) {
  return { statusCode, headers: { ...CORS, "Cache-Control": "no-store", ...(extra || {}) }, body: typeof body === "string" ? body : JSON.stringify(body) };
}

async function handle(event, deps) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "GET") return reply(405, { error: "Method not allowed." });
  if (!deps.url || !deps.key) { console.error("fincap-feed misconfigured: missing Supabase env vars."); return reply(500, { error: "Server misconfigured." }); }
  const q = event.queryStringParameters || {};
  try {
    if (q.view === "newsletter") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(q.issue || "") || Number.isNaN(Date.parse(q.issue))) return reply(400, { error: "Use issue=YYYY-MM-DD." });
      let repeat = null;
      if (q.repeat_within_days != null && q.repeat_within_days !== "") {
        repeat = Number(q.repeat_within_days);
        if (!Number.isInteger(repeat) || repeat < 0 || repeat > 60) return reply(400, { error: "repeat_within_days must be 0 to 60." });
      }
      const raw = await rpc(deps, "fincap_newsletter_export", { p_issue_date: q.issue, p_repeat_deadline_days: repeat });
      const exp = {
        issue_date: raw.issue_date,
        items: (raw.items || []).map(projectNewsletter),
        held_for_recheck: (raw.held_for_recheck || []).map((h) => ({ id: h.id, title: h.title })),
        previously_included_count: Number(raw.previously_included_count) || 0,
        note: "Read-only export. It does not record or send anything.",
      };
      const headers = { "Cache-Control": CACHE };
      if (q.format === "md") return { statusCode: 200, headers: { ...CORS, ...headers, "Content-Type": "text/markdown; charset=utf-8" }, body: toMarkdown(exp) };
      return reply(200, exp, { ...headers, "Content-Type": "application/json; charset=utf-8" });
    }
    if (q.view === "opportunities" || !q.view) {
      const rows = await rpc(deps, "fincap_public_list", { p_limit: 200 });
      return reply(200, { opportunities: rows.map(projectPublic) }, { "Cache-Control": CACHE, "Content-Type": "application/json; charset=utf-8" });
    }
    return reply(400, { error: "Unknown view." });
  } catch (e) {
    console.error("fincap-feed error:", e && e.message);
    return reply(502, { error: "The feed is temporarily unavailable." });
  }
}

exports.handler = (event) => handle(event, { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, fetch: (...a) => fetch(...a) });
exports._test = { handle, projectPublic, projectNewsletter, toMarkdown, PUBLIC_FIELDS };
