// netlify/functions/grants-gov-crawler-background.js
//
// Daily Grants.gov opportunity crawler for Opportunity Assist. Populates the
// same shared `opportunities` table the SAM.gov crawler writes to -- this is
// the actual federal GRANTS system, distinct from SAM.gov (which is almost
// entirely contract/procurement solicitations). For a nonprofit-heavy
// audience, this is arguably the more important of the two sources.
//
// Uses Grants.gov's public search2 API, which needs NO API key -- one less
// thing to configure than SAM.gov. Runs on a schedule (see netlify.toml) as
// a Background Function, matching the SAM.gov crawler's shape.
//
// PER-ORG KEYWORDS. The crawl pool used to be one fixed BASELINE_KEYWORDS
// list shared by every organization -- meaning Fit Scoring could only ever
// rank what that narrow, generic list happened to pull in. An org whose
// niche wasn't well covered by those terms would see nothing relevant no
// matter how good their profile was, since scoring can't surface an
// opportunity the crawl never fetched. This function now also reads every
// organization's own `keywords` and searches Grants.gov with those too, so
// the pool actually grows to match who's using the product, not just a
// starter guess. BASELINE_KEYWORDS stays in the mix as a floor -- it keeps
// the pool useful for orgs that haven't filled out a profile yet (including
// guest/demo sessions) and before there are many subscribers to draw from.
//
// Deliberately does NOT filter by Grants.gov's eligibility or funding-
// category codes: the sourcing on those exact code values was inconsistent
// enough that guessing wrong risked silently filtering out every
// nonprofit-eligible grant, a worse failure than pulling a bit broader.
// Instead this searches by keyword only and leans on the AI Fit Scoring
// every org already gets to sort eligibility fit per organization.
//
// Also does NOT call the per-opportunity fetchOpportunity endpoint for full
// description text, for the same reason the SAM.gov crawler skips SAM's
// per-notice description call: keeps the crawl fast, and title, agency,
// dates, and a direct link are enough for AI Fit Scoring to work with. A
// reasonable Phase 2 addition if practitioners want the full text pulled in.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  writing to `opportunities` is a shared, global
//                              write, not something any signed-in user's own
//                              session should be able to do. Also used here
//                              to read every org's keywords -- a read no
//                              single signed-in session should have either.
//
// No API key needed for Grants.gov itself, and no new SQL migration either --
// this reuses the external_id column and unique index already added by
// docs/sam-gov-crawler-setup.sql.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Baseline floor, matching workforce development, financial capability,
// youth employment, and community-prosperity work generally. Always
// searched in addition to whatever real organizations' own keywords add.
const BASELINE_KEYWORDS = [
  "workforce development",
  "youth employment",
  "financial capability",
  "financial literacy",
  "community development",
  "self-sufficiency",
];

// Safety cap on total keywords searched in one run (baseline + every org's
// own keywords, deduped). Concurrency is batched (see BATCH_SIZE) so this
// comfortably fits a background function's 15-minute budget even near the
// cap -- this exists to keep a single run bounded and predictable as the
// subscriber base grows, not because the real number is expected to get
// close to it soon.
const MAX_KEYWORDS = 200;

// How many Grants.gov searches run concurrently. Firing every keyword at
// once stops being reasonable once this is dozens of searches instead of 6
// -- batching keeps this a well-behaved caller of a public government API
// rather than a burst of concurrent requests.
const BATCH_SIZE = 10;

const ROWS_PER_KEYWORD = 25;

exports.handler = async () => {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("grants-gov-crawler misconfigured: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    return;
  }

  let orgKeywords = [];
  try {
    orgKeywords = await fetchOrgKeywords();
  } catch (err) {
    console.error("Could not fetch organization keywords, continuing with baseline only:", err.message);
  }

  const seen = new Set();
  const keywords = [];
  BASELINE_KEYWORDS.concat(orgKeywords).forEach((kw) => {
    const clean = (kw || "").trim().toLowerCase();
    if (clean && !seen.has(clean)) { seen.add(clean); keywords.push(clean); }
  });
  const truncated = keywords.length > MAX_KEYWORDS;
  const finalKeywords = keywords.slice(0, MAX_KEYWORDS);

  console.log("Grants.gov crawl:", finalKeywords.length, "keywords (", BASELINE_KEYWORDS.length, "baseline +",
    orgKeywords.length, "raw from org profiles, deduped)", truncated ? "-- truncated to MAX_KEYWORDS" : "");

  const results = await runInBatches(finalKeywords, BATCH_SIZE, fetchKeyword);

  let fetched = 0;
  let failed = 0;
  const rows = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      fetched += r.value.length;
      rows.push(...r.value);
    } else {
      failed++;
      console.error("Keyword", finalKeywords[i], "fetch failed:", r.reason && r.reason.message);
    }
  });

  // De-dupe across overlapping keyword matches within this run before upserting.
  const byId = {};
  rows.forEach((row) => { byId[row.external_id] = row; });
  const unique = Object.values(byId);

  let upserted = 0;
  for (let i = 0; i < unique.length; i += 200) {
    const batch = unique.slice(i, i + 200);
    try {
      await sbUpsert("opportunities", batch, "external_id");
      upserted += batch.length;
    } catch (err) {
      failed += batch.length;
      console.error("Upsert batch failed:", err.message);
    }
  }

  console.log("Grants.gov crawl done:", { keywordsSearched: finalKeywords.length, fetched, unique: unique.length, upserted, failed });
};

// Pulls every organization's own keywords so the crawl pool reflects who's
// actually using the product, not just the fixed baseline list. Uses the
// service role, since reading every org's keywords isn't something any
// single signed-in user's session should be able to do.
async function fetchOrgKeywords() {
  const r = await fetch(SUPABASE_URL + "/rest/v1/organizations?select=keywords", {
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY },
  });
  if (!r.ok) throw new Error("organizations fetch failed: " + (await r.text()));
  const orgs = await r.json();
  const out = [];
  orgs.forEach((org) => { (org.keywords || []).forEach((k) => { if (k) out.push(k); }); });
  return out;
}

// Runs `fn` over `items` with at most `batchSize` in flight at once,
// returning Promise.allSettled-shaped results in the original item order.
async function runInBatches(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

async function fetchKeyword(keyword) {
  const r = await fetch("https://api.grants.gov/v1/api/search2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rows: ROWS_PER_KEYWORD,
      keyword,
      oppStatuses: "forecasted|posted",
    }),
  });
  if (!r.ok) throw new Error("Grants.gov API error (" + r.status + "): " + (await r.text()).slice(0, 300));
  const json = await r.json();
  const hits = (json.data && json.data.oppHits) || json.oppHits || [];
  return hits.map(mapOpportunity).filter((o) => o.external_id);
}

function mapOpportunity(hit) {
  const id = hit.id || hit.oppId || hit.opportunityId;
  const number = hit.number || hit.oppNumber || hit.opportunityNumber || "";
  const title = hit.title || hit.opportunityTitle || "Untitled opportunity";
  const agency = hit.agencyName || hit.agency || hit.agencyCode || "";
  const closeDate = hit.closeDate || hit.responseDate || null;
  const status = hit.oppStatus || hit.status || "";

  return {
    external_id: id ? "grantsgov-" + id : null,
    source: "Grants.gov",
    source_url: id ? "https://grants.gov/search-results-detail/" + id : "https://grants.gov/search-grants",
    title,
    category: status === "forecasted" ? "Forecasted Grant" : "Grant Opportunity",
    geography: "National",
    funding_amount: null,
    funding_amount_label: null,
    deadline: closeDate,
    requirements: "Opportunity number " + (number || "\u2014") + (agency ? ", posted by " + agency : ""),
    summary: (agency ? agency + " \u2014 " : "") + "View the full notice on Grants.gov for complete eligibility, requirements, and application details.",
  };
}

/* ---------- Supabase REST helper (service role -- bypasses RLS by design) ---------- */

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
