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
// Two things this function is careful about, both worth explaining:
//
// RELEVANCE. A funder can have a current, open grant program that has
// nothing to do with financial capability, workforce development, or youth
// employment. Reporting every open program regardless of fit would make the
// weekly report noise, not a report. The prompt below judges relevance
// against Opportunity Assist's actual focus areas, not just "is anything
// open right now."
//
// ACCURACY. Nothing gets invented: if a deadline or amount is not actually
// stated on the page, the field comes back null, not a guess. Beyond that,
// deadline and amount are the two fields most likely to cause real harm if
// wrong -- a practitioner acting on a fabricated deadline is a genuine
// problem, not a cosmetic one. So those two fields are held to a higher bar
// than "trust the model": the prompt requires them to be copied VERBATIM
// from the page text, and the code below then mechanically checks that the
// exact quote is actually present in what was fetched. This is a real,
// deterministic check, not a second AI opinion -- two AI calls grading each
// other share the same blind spots, so this asks for something checkable
// instead. It has a real limitation worth naming: a true, accurate deadline
// phrased slightly differently by the model than the page (say, punctuation)
// can come back "unverified" even though it's correct. Marked unverified
// means "check this one before trusting it," not "this is wrong."
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

// The focus areas relevance is judged against. Keep this in sync with how
// Opportunity Assist describes itself elsewhere (index.html, the AI Fit
// Scoring prompt in score-opportunities.js) so "relevant" means the same
// thing across the app.
const FOCUS_AREAS =
  "financial capability, financial literacy/coaching/counseling, workforce development, " +
  "youth employment, VITA (free tax prep), CRA-aligned community development, career and " +
  "technical education, economic mobility and self-sufficiency, and community prosperity work";

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
    "You read a funder's website and report ONLY what is explicitly stated on the page. This feeds a weekly report " +
    "used by nonprofit practitioners deciding whether to pursue funding, so accuracy and relevance both matter more " +
    "than completeness.\n\n" +
    "RELEVANCE: only report an opportunity if it is a plausible fit for organizations working in " + FOCUS_AREAS + ". " +
    "A funder can have an open program for something else entirely (arts, environment, health) -- that is not a match, " +
    "even though it is a real open opportunity. If there is no CURRENT, RELEVANT opportunity, set " +
    'has_relevant_opportunity to false and leave the other fields null.\n\n' +
    "ACCURACY: never invent a deadline, amount, or eligibility detail that is not actually written on the page -- " +
    "null is correct when something isn't stated. For deadline_mentioned and amount_mentioned specifically: if present, " +
    "copy them VERBATIM from the page text below, exact wording and punctuation, do not paraphrase or reformat -- these " +
    "two fields are checked automatically against the source text, so an exact quote is required for that check to work.\n\n" +
    "Respond with ONLY valid JSON, no prose, no markdown fences, matching this shape: " +
    '{"has_relevant_opportunity": <boolean>, "program_name": "<string or null>", ' +
    '"relevance_note": "<one sentence on why this fits the focus areas, only if has_relevant_opportunity is true, else null>", ' +
    '"summary": "<1-3 sentences, only from what the page states, or null>", ' +
    '"deadline_mentioned": "<exact verbatim quote from the page, or null>", "amount_mentioned": "<exact verbatim quote from the page, or null>", ' +
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

  if (!parsed.has_relevant_opportunity) return null;

  const deadlineMentioned = parsed.deadline_mentioned || null;
  const amountMentioned = parsed.amount_mentioned || null;

  return {
    funder_name: funder.name,
    source_url: funder.url,
    program_name: parsed.program_name || null,
    relevance_note: parsed.relevance_note || null,
    summary: parsed.summary || null,
    deadline_mentioned: deadlineMentioned,
    deadline_verified: deadlineMentioned ? quotedInText(deadlineMentioned, text) : null,
    amount_mentioned: amountMentioned,
    amount_verified: amountMentioned ? quotedInText(amountMentioned, text) : null,
    requires_loi: typeof parsed.requires_loi === "boolean" ? parsed.requires_loi : null,
    application_url: parsed.application_url || funder.url,
  };
}

// Deterministic check, not another AI guess: does the claimed quote actually
// appear in the page text that was fetched? Normalizes whitespace and case
// only -- a real limitation is that a true, accurate value phrased slightly
// differently by the model (different punctuation, "March 15th" vs
// "March 15") can come back false even though it's correct. False here means
// "verify this one," not "this is wrong."
function quotedInText(quote, pageText) {
  const normalize = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const needle = normalize(quote);
  if (!needle) return false;
  return normalize(pageText).indexOf(needle) !== -1;
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
