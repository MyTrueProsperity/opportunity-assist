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
//                              session should be able to do.
//
// No API key needed for Grants.gov itself, and no new SQL migration either --
// this reuses the external_id column and unique index already added by
// docs/sam-gov-crawler-setup.sql.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Starter keyword list matching workforce development, financial capability,
// youth employment, and community-prosperity work. Same role as the NAICS
// list in the SAM.gov crawler: the single biggest lever on relevance, edit
// freely.
const KEYWORDS = [
  "workforce development",
  "youth employment",
  "financial capability",
  "financial literacy",
  "community development",
  "self-sufficiency",
];

const ROWS_PER_KEYWORD = 25;

exports.handler = async () => {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("grants-gov-crawler misconfigured: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    return;
  }

  console.log("Grants.gov crawl: across", KEYWORDS.length, "keywords");

  const results = await Promise.allSettled(KEYWORDS.map((kw) => fetchKeyword(kw)));

  let fetched = 0;
  let failed = 0;
  const rows = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      fetched += r.value.length;
      rows.push(...r.value);
    } else {
      failed++;
      console.error("Keyword", KEYWORDS[i], "fetch failed:", r.reason && r.reason.message);
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

  console.log("Grants.gov crawl done:", { fetched, unique: unique.length, upserted, failed });
};

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
