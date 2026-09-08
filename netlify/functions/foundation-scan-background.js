// netlify/functions/foundation-scan-background.js
//
// AI-assisted scan of individual foundation and funder websites that,
// unlike SAM.gov and Grants.gov, have no structured API at all -- just a
// webpage. Results write into the SAME `opportunities` table the other two
// crawlers use, clearly labeled (source: "Foundation Scan") so the app can
// still show these as AI-read rather than an official government posting --
// but living in the same pool means every subscribing organization now gets
// a REAL, per-org AI Fit Score against these hits, the same way they
// already do for SAM.gov and Grants.gov results.
//
// REDESIGNED FROM A SEPARATE TABLE + WEEKLY SCAN. The original version
// wrote to its own `foundation_scan_hits` table and judged relevance once,
// against one hardcoded description of Bill's own focus areas. That worked
// for a single-organization tool, but Opportunity Assist has multiple
// subscribing organizations with different missions -- a single global
// relevance filter can only ever be tuned to the org it was written for.
// This version drops that judgment call entirely: it just reports whether a
// CURRENT, OPEN opportunity exists on the page, and leaves "is this
// relevant to a specific organization" to the AI Fit Scoring every org
// already gets on every opportunity in the shared pool -- the same real,
// per-org matching mechanism, not a copy of the idea that only worked for
// one org.
//
// DAILY, SHARDED BY DAY OF WEEK, NOT WEEKLY. A once-a-week scan of
// everything has a real problem that gets worse as the watchlist grows: a
// short-window or rolling opportunity can open and close entirely between
// scans, and a bigger list eventually risks the 15-minute execution limit
// in a single run regardless. This runs daily instead, scanning roughly
// 1/SHARD_COUNT of the watchlist each day (day-of-week determines which
// slice) -- every funder still gets checked at least weekly, but adding
// more funders to the list makes each day's slice modestly bigger rather
// than making the one weekly run unboundedly bigger, and a Wednesday change
// gets caught within a day instead of waiting for the next Monday.
//
// ACTIVELY CLEARS EXPIRED HITS. If a funder that previously had an open
// opportunity no longer does on a later scan, any existing row for that
// funder is deleted, not just left stale -- "not once they expire" means
// actively removing closed opportunities from the radar, not only adding
// new ones. This only happens on a scan that successfully completed and
// found nothing open; a fetch failure or timeout never deletes an existing
// row, since a site being briefly unreachable is not evidence the
// opportunity closed.
//
// ACCURACY. Nothing gets invented: if a deadline or amount is not actually
// stated on the page, the field comes back null, not a guess. Deadline and
// amount are held to a higher bar than "trust the model": the prompt
// requires them to be copied VERBATIM from the page, and the code then
// mechanically checks the exact quote is actually present in what was
// fetched -- a real, deterministic check, not a second AI opinion. Worth
// being upfront about a real limitation this creates: these are stored as
// verbatim text (deadline_mentioned), not a structured date, because a page
// saying "August 1" without a year is not something that can be honestly
// converted to a real date without guessing which year -- so these
// deadlines show up as informational text on the opportunity, not as
// something Alerts' deadline-based rules can act on the way a SAM.gov or
// Grants.gov structured deadline can.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5-20251001";

// How many days the full watchlist is spread across. 7 means a full cycle
// once a week (every funder checked at least that often) while each day's
// run only has to cover ~1/7th of the list. Raise this (or scan more than
// once a day) if the list grows enough that a 1/7th slice gets large, or if
// funders need to be checked more often than weekly.
const SHARD_COUNT = 7;

// Full watchlist now lives in the funder_watchlist table in Supabase, not
// hardcoded here -- see sbSelectAll() below. This is what makes adding a
// new list of funders a database insert instead of an edit-and-push of
// this file: the watchlist grew past the point where hand-pasting the
// whole file back into GitHub was a sane way to add a few hundred more
// rows. Grants.gov and SAM.gov Assistance Listings are still deliberately
// excluded from that table even when a source list includes them -- both
// are already covered by dedicated, structured-API crawlers elsewhere in
// this codebase (grants-gov-crawler-background.js,
// sam-gov-crawler-background.js).

// Every fetch here goes to a DIFFERENT domain (unlike the SAM.gov/Grants.gov
// crawlers, which repeat calls to one API and need to be a well-behaved
// caller of that one server) -- load is spread across thousands of distinct
// servers, not concentrated on one, so higher concurrency is fine here.
const BATCH_SIZE = 50;

// A handful of real sites will hang instead of failing cleanly. Without a
// cap, one slow server could stall its whole batch for minutes.
const FETCH_TIMEOUT_MS = 10000;

exports.handler = async () => {
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_API_KEY) {
    console.error("foundation-scan misconfigured: missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or ANTHROPIC_API_KEY.");
    return;
  }

  const watchlist = await sbSelectAll("funder_watchlist", "name,url");

  const shard = new Date().getUTCDay() % SHARD_COUNT;
  const todaysFunders = watchlist.filter((_, i) => i % SHARD_COUNT === shard);

  console.log("Foundation scan: shard", shard, "of", SHARD_COUNT, "--", todaysFunders.length,
    "of", watchlist.length, "total funders");

  let scanned = 0;
  let found = 0;
  let upserted = 0;
  let cleared = 0;
  let failed = 0;

  for (let i = 0; i < todaysFunders.length; i += BATCH_SIZE) {
    const batch = todaysFunders.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(scanFunder));

    const toUpsert = [];
    const toClear = [];
    results.forEach((r, j) => {
      scanned++;
      if (r.status === "fulfilled") {
        if (r.value) { toUpsert.push(r.value); found++; }
        else { toClear.push(externalIdFor(batch[j].url)); }
      } else {
        failed++;
        console.error("Scan of", batch[j].name, "failed:", r.reason && r.reason.message);
      }
    });

    if (toUpsert.length) {
      try {
        await sbUpsert("opportunities", toUpsert, "external_id");
        upserted += toUpsert.length;
      } catch (err) {
        console.error("Upsert batch failed:", err.message);
      }
    }
    for (const id of toClear) {
      try {
        const didDelete = await sbDeleteIfExists("opportunities", id);
        if (didDelete) cleared++;
      } catch (err) {
        console.error("Clear of", id, "failed:", err.message);
      }
    }
  }

  console.log("Foundation scan done:", { shard, scanned, found, upserted, cleared, failed });
};

// Keys by the full URL (normalized), not just the domain. Many funders have
// multiple genuinely distinct grant programs living at different specific
// pages on the same domain -- a foundation's general grants page and a
// named scholarship program's own page, say. Keying by domain alone would
// let those collide into whichever was scanned last; keying by full URL
// lets each stay its own opportunity, cleared independently if that
// specific page later has nothing open.
function externalIdFor(url) {
  const normalized = url.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
  return "foundationscan-" + normalized;
}

async function scanFunder(funder) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let pageRes;
  try {
    pageRes = await fetch(funder.url, { redirect: "follow", signal: controller.signal });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "timed out after " + FETCH_TIMEOUT_MS + "ms" : e.message);
  } finally {
    clearTimeout(timer);
  }
  if (!pageRes.ok) throw new Error("fetch failed (" + pageRes.status + ")");
  const html = await pageRes.text();
  const text = htmlToText(html).slice(0, 12000);
  if (!text) throw new Error("no readable text on page");

  const system =
    "You read a funder's website and report whether it currently describes a CURRENT, OPEN grant or funding " +
    "opportunity that a nonprofit or community organization could apply to now or in the near future. This feeds " +
    "a shared pool used by many different organizations with different missions -- do not judge whether it fits " +
    "any particular organization's focus area, only whether a genuine, currently-open opportunity is described. " +
    "Each subscribing organization's own scoring separately judges fit against their specific work.\n\n" +
    "Report ONLY what is explicitly stated on the page. Never invent a deadline, amount, or eligibility detail " +
    "that is not actually written on the page -- null is correct when something isn't stated. For " +
    "deadline_mentioned and amount_mentioned specifically: if present, copy them VERBATIM from the page text " +
    "below, exact wording and punctuation, do not paraphrase or reformat -- these two fields are checked " +
    "automatically against the source text, so an exact quote is required for that check to work.\n\n" +
    "Respond with ONLY valid JSON, no prose, no markdown fences, matching this shape: " +
    '{"has_open_opportunity": <boolean>, "program_name": "<string or null>", ' +
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

  // null (not a hit, but successfully scanned) tells the caller to clear any
  // previously-stored row for this funder -- an explicit "no longer open"
  // signal, not just silence.
  if (!parsed.has_open_opportunity) return null;

  const deadlineMentioned = parsed.deadline_mentioned || null;
  const amountMentioned = parsed.amount_mentioned || null;

  return {
    external_id: externalIdFor(funder.url),
    source: "Foundation Scan",
    source_url: parsed.application_url || funder.url,
    title: funder.name + (parsed.program_name ? ": " + parsed.program_name : ""),
    category: "Foundation Grant",
    geography: null,
    funding_amount: null,
    funding_amount_label: null,
    deadline: null,
    deadline_mentioned: deadlineMentioned,
    deadline_verified: deadlineMentioned ? quotedInText(deadlineMentioned, text) : null,
    amount_mentioned: amountMentioned,
    amount_verified: amountMentioned ? quotedInText(amountMentioned, text) : null,
    requirements: parsed.requires_loi ? "Letter of Inquiry (LOI) required" : null,
    summary: parsed.summary || null,
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

/* ---------- Supabase REST helpers (service role -- bypasses RLS by design) ---------- */

async function sbUpsert(table, rows, onConflict) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?on_conflict=" + onConflict, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(table + " upsert failed: " + (await r.text()));
}

// Reads every row of a table via Supabase's PostgREST endpoint, paging
// through with the Range header since PostgREST caps a single response at
// 1000 rows by default -- the watchlist alone is well past that, so a
// single unpaged GET would silently truncate it.
async function sbSelectAll(table, select) {
  const pageSize = 1000;
  let all = [];
  let from = 0;
  for (;;) {
    const r = await fetch(
      SUPABASE_URL + "/rest/v1/" + table + "?select=" + encodeURIComponent(select),
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: "Bearer " + SERVICE_KEY,
          Range: from + "-" + (from + pageSize - 1),
        },
      }
    );
    if (!r.ok) throw new Error(table + " select failed: " + (await r.text()));
    const page = await r.json();
    all = all.concat(page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// Deletes the row with this external_id if one exists; returns true if a row
// was actually removed. Used to clear a previously-found opportunity that a
// later scan confirmed is no longer open -- never called on a fetch
// failure, only on a scan that completed and found nothing.
async function sbDeleteIfExists(table, externalId) {
  const r = await fetch(
    SUPABASE_URL + "/rest/v1/" + table + "?external_id=eq." + encodeURIComponent(externalId),
    {
      method: "DELETE",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: "Bearer " + SERVICE_KEY,
        Prefer: "return=representation",
      },
    }
  );
  if (!r.ok) throw new Error(table + " delete failed: " + (await r.text()));
  const deleted = await r.json();
  return Array.isArray(deleted) && deleted.length > 0;
}
