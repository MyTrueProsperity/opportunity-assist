// netlify/functions/foundation-scan-background.js
//
// Weekly AI-assisted scan of individual foundation and funder websites that,
// unlike SAM.gov and Grants.gov, have no structured API at all -- just a
// webpage. This is fundamentally different in kind from the rest of the
// `opportunities` table: those rows are structured government API data,
// these are Claude's best read of a webpage at scan time. That is exactly
// why results land in a SEPARATE table (foundation_scan_hits), not mixed
// into `opportunities` -- the app must show these labeled as AI-read and
// unverified, never with the same confidence as an official posting.
//
// The system prompt is explicit that nothing gets invented: if a deadline
// or amount is not actually stated on the page, the field comes back null,
// not a guess. A wrong invented number is worse than a missing one -- a
// practitioner acting on a fabricated deadline is a real harm, an empty
// field is just a reason to click through and check.
//
// Runs weekly (see netlify.toml), on its own day/time separate from the two
// daily crawlers, since it's a much heavier per-item operation (a fetch plus
// a Claude call per funder, not a single structured API request).
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5-20251001";

// Starter watchlist: Florida / Central Florida funders first (highest direct
// relevance to MTP's own footprint), then national funders whose stated
// focus areas are a close match for financial capability, workforce
// development, and youth employment work. Same role as the NAICS/keyword
// lists in the other two crawlers -- edit freely, this is a starting point
// pulled from a much larger source list, not a definitive one.
const FUNDER_WATCHLIST = [
  { name: "Central Florida Foundation", url: "https://cffound.org" },
  { name: "Edyth Bush Charitable Foundation", url: "https://edythbush.org" },
  { name: "Dr. Phillips Charities", url: "https://drphillips.org" },
  { name: "Heart of Florida United Way", url: "https://hfuw.org" },
  { name: "Helios Education Foundation", url: "https://helios.org" },
  { name: "The Able Trust", url: "https://abletrust.org" },
  { name: "FAIRWINDS Foundation", url: "https://fairwinds.org" },
  { name: "Florida Blue Foundation", url: "https://floridabluefoundation.com" },
  { name: "Jim Moran Foundation", url: "https://jimmoranfoundation.org" },
  { name: "Community Foundation Tampa Bay", url: "https://cftampabay.org" },
  { name: "FINRA Investor Education Foundation", url: "https://finrafoundation.org" },
  { name: "National Endowment for Financial Education", url: "https://nefe.org" },
  { name: "Cities for Financial Empowerment Fund", url: "https://cfefund.org" },
  { name: "Prosperity Now", url: "https://prosperitynow.org" },
  { name: "Foundation for Financial Planning", url: "https://ffpprobono.org" },
  { name: "Annie E. Casey Foundation", url: "https://aecf.org" },
  { name: "Kresge Foundation", url: "https://kresge.org" },
  { name: "NeighborWorks America", url: "https://neighborworks.org" },
  { name: "Charles Schwab Foundation", url: "https://schwabmoneywise.com" },
  { name: "Citi Foundation", url: "https://citigroup.com" },
];

exports.handler = async () => {
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_API_KEY) {
    console.error("foundation-scan misconfigured: missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or ANTHROPIC_API_KEY.");
    return;
  }

  console.log("Foundation scan: across", FUNDER_WATCHLIST.length, "funders");

  const results = await Promise.allSettled(FUNDER_WATCHLIST.map((f) => scanFunder(f)));

  let found = 0;
  let failed = 0;
  const rows = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      if (r.value) { rows.push(r.value); found++; }
    } else {
      failed++;
      console.error("Scan of", FUNDER_WATCHLIST[i].name, "failed:", r.reason && r.reason.message);
    }
  });

  if (rows.length) {
    try {
      await sbInsert("foundation_scan_hits", rows);
    } catch (err) {
      console.error("Insert failed:", err.message);
    }
  }

  console.log("Foundation scan done:", { scanned: FUNDER_WATCHLIST.length, found, failed });
};

async function scanFunder(funder) {
  const pageRes = await fetch(funder.url, { redirect: "follow" });
  if (!pageRes.ok) throw new Error("fetch failed (" + pageRes.status + ")");
  const html = await pageRes.text();
  const text = htmlToText(html).slice(0, 12000);
  if (!text) throw new Error("no readable text on page");

  const system =
    "You read a funder's website and report ONLY what is explicitly stated on the page. This feeds a tool used by " +
    "nonprofit practitioners deciding whether to pursue funding, so accuracy matters more than completeness. " +
    "If a deadline, amount, or eligibility detail is not actually written on the page, the field must be null, " +
    "never a guess or an estimate. Respond with ONLY valid JSON, no prose, no markdown fences, matching this shape: " +
    '{"has_current_opportunity": <boolean>, "program_name": "<string or null>", "summary": "<1-3 sentences, only from what the page states, or null>", ' +
    '"deadline_mentioned": "<string exactly as stated, or null>", "amount_mentioned": "<string exactly as stated, or null>", ' +
    '"requires_loi": <boolean or null>, "application_url": "<string or null>"}';

  const user = "Funder: " + funder.name + "\nPage URL: " + funder.url + "\n\nPage text:\n" + text;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error("Anthropic API error: " + (await r.text()).slice(0, 200));
  const data = await r.json();
  const replyText = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");

  let parsed;
  try {
    parsed = JSON.parse(replyText.replace(/```json|```/g, "").trim());
  } catch (e) {
    throw new Error("could not parse AI response as JSON");
  }

  if (!parsed.has_current_opportunity) return null;

  return {
    funder_name: funder.name,
    source_url: funder.url,
    program_name: parsed.program_name || null,
    summary: parsed.summary || null,
    deadline_mentioned: parsed.deadline_mentioned || null,
    amount_mentioned: parsed.amount_mentioned || null,
    requires_loi: typeof parsed.requires_loi === "boolean" ? parsed.requires_loi : null,
    application_url: parsed.application_url || funder.url,
  };
}

// Lightweight, dependency-free HTML-to-text: strips script/style blocks and
// tags, decodes a handful of common entities, collapses whitespace. Not a
// real parser -- a best-effort reduction of a page to readable text, which
// is all the AI read above needs.
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------- Supabase REST helper (service role -- bypasses RLS by design) ---------- */

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
