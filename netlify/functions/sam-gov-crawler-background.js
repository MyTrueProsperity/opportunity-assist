// netlify/functions/sam-gov-crawler-background.js
//
// Daily SAM.gov opportunity crawler for Opportunity Assist. Populates the
// shared `opportunities` table that every organization's Funding Radar reads
// from. Runs on a schedule (see netlify.toml) as a Background Function --
// several sequential SAM.gov + Supabase calls can run past the 10s limit on
// a regular synchronous function, and background functions get up to 15 min.
//
// TWO SEARCH AXES. NAICS_CODES searches by industry classification -- broad,
// but only as relevant as the fixed 6 codes chosen. A second axis now also
// searches by TITLE using each organization's own keywords (the same field
// grants-gov-crawler-background.js already draws from), the same fix
// applied there for the same reason: Fit Scoring can only rank what the
// crawl actually fetched, so a fixed, generic filter means an org outside
// that narrow starter list sees nothing relevant no matter how good their
// profile is. `title` is a real, documented SAM.gov v2 parameter (see
// open.gsa.gov/api/get-opportunities-public-api/), not a guess.
//
// Worth being upfront about a real limitation: SAM.gov contract titles tend
// to be procurement-generic ("IT Support Services," "Facility Maintenance
// Contract") rather than mission-descriptive the way Grants.gov program
// titles often are. A phrase like "youth employment" is less likely to
// literally appear in a SAM.gov title than in a grant program's name, so
// this axis will likely surface fewer hits per keyword than the same
// approach did on Grants.gov. Still worth having -- just not a guaranteed
// parallel yield.
//
// This does NOT fetch each opportunity's full description text -- that's a
// second authenticated SAM.gov call per notice and adds real cost/time for a
// crawl this size. What's stored here (title, agency, type, NAICS, place of
// performance, deadline, set-aside, and a direct link to the full posting)
// is enough for AI Fit Scoring to work with, and the source link covers the
// rest. Worth revisiting if practitioners want the full text pulled in too.
//
// Env vars required:
//   SAM_GOV_API_KEY            free key -- see readme.md "Opportunity Crawler"
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  writing to `opportunities` is a shared, global
//                              write, not something any signed-in user's own
//                              session should be able to do. Also used here
//                              to read every org's keywords -- a read no
//                              single signed-in session should have either.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SAM_API_KEY = process.env.SAM_GOV_API_KEY;

// Starter NAICS list matching workforce development, financial capability,
// youth employment, VITA/CRA-adjacent, and community-prosperity work. Edit
// freely -- still a real, useful axis on its own, complementary to the
// title-keyword search below, not replaced by it.
const NAICS_CODES = [
  "611430", // Professional and Management Development Training
  "611710", // Educational Support Services
  "624190", // Other Individual and Family Services
  "624310", // Vocational Rehabilitation Services
  "813219", // Other Grantmaking and Giving Services
  "813319", // Other Social Advocacy Organizations
];

// Baseline floor for the title-keyword axis, same role and same terms as
// grants-gov-crawler-background.js for consistency -- always searched in
// addition to whatever real organizations' own keywords add.
const BASELINE_KEYWORDS = [
  "workforce development",
  "youth employment",
  "financial capability",
  "financial literacy",
  "community development",
  "self-sufficiency",
];

// Lower than Grants.gov's equivalent caps: this axis runs alongside the
// existing NAICS loop (roughly doubling total request volume), and SAM.gov
// is more heavily rate-limited than Grants.gov's unauthenticated API.
const MAX_KEYWORDS = 40;
const BATCH_SIZE = 5;

// o=Solicitation, p=Presolicitation, k=Combined Synopsis/Solicitation,
// r=Sources Sought, s=Special Notice. Deliberately excludes "a" (Award
// Notice) -- those are already decided, not opportunities left to pursue.
const PTYPES = "o,p,k,r,s";

// Look back a couple of days past a typical daily run as a safety buffer in
// case a scheduled run is ever missed. Widen if the crawl schedule changes.
const LOOKBACK_DAYS = 2;

exports.handler = async () => {
  if (!SUPABASE_URL || !SERVICE_KEY || !SAM_API_KEY) {
    console.error("sam-gov-crawler misconfigured: missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or SAM_GOV_API_KEY.");
    return;
  }

  const { postedFrom, postedTo } = dateWindow(LOOKBACK_DAYS);

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

  console.log("SAM.gov crawl:", postedFrom, "to", postedTo, "--", NAICS_CODES.length, "NAICS codes +",
    finalKeywords.length, "title keywords (", BASELINE_KEYWORDS.length, "baseline +", orgKeywords.length,
    "raw from org profiles, deduped)", truncated ? "-- truncated to MAX_KEYWORDS" : "");

  const naicsResults = await Promise.allSettled(
    NAICS_CODES.map((code) => fetchByParam({ ncode: code }, postedFrom, postedTo, 5))
  );
  const keywordResults = await runInBatches(
    finalKeywords, BATCH_SIZE, (kw) => fetchByParam({ title: kw }, postedFrom, postedTo, 2)
  );

  let fetched = 0;
  let failed = 0;
  const rows = [];
  naicsResults.forEach((r, i) => {
    if (r.status === "fulfilled") { fetched += r.value.length; rows.push(...r.value); }
    else { failed++; console.error("NAICS", NAICS_CODES[i], "fetch failed:", r.reason && r.reason.message); }
  });
  keywordResults.forEach((r, i) => {
    if (r.status === "fulfilled") { fetched += r.value.length; rows.push(...r.value); }
    else { failed++; console.error("Title keyword", finalKeywords[i], "fetch failed:", r.reason && r.reason.message); }
  });

  // De-dupe across overlapping NAICS/keyword matches within this run before upserting.
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

  console.log("SAM.gov crawl done:", { fetched, unique: unique.length, upserted, failed });
};

// Pulls every organization's own keywords, same helper/table/column as
// grants-gov-crawler-background.js. Service role, since reading every org's
// keywords isn't something any single signed-in user's session should do.
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

async function runInBatches(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// extraParams is either { ncode } or { title } -- the one axis-specific
// filter, everything else about the request is shared between both axes.
async function fetchByParam(extraParams, postedFrom, postedTo, maxPages) {
  const rows = [];
  let offset = 0;
  const limit = 1000;
  for (let page = 0; page < maxPages; page++) {
    const url =
      "https://api.sam.gov/opportunities/v2/search?" +
      new URLSearchParams(Object.assign({
        api_key: SAM_API_KEY,
        postedFrom,
        postedTo,
        ptype: PTYPES,
        limit: String(limit),
        offset: String(offset),
      }, extraParams)).toString();

    const r = await fetch(url);
    if (!r.ok) throw new Error("SAM.gov API error (" + r.status + "): " + (await r.text()).slice(0, 300));
    const data = await r.json();
    const items = data.opportunitiesData || [];
    items.forEach((opp) => rows.push(mapOpportunity(opp)));

    offset += limit;
    if (items.length === 0 || offset >= (data.totalRecords || 0)) break;
  }
  return rows;
}

function mapOpportunity(opp) {
  const pop = opp.placeOfPerformance || {};
  const state = (pop.state && (pop.state.name || pop.state.code)) || "";
  const setAside = opp.typeOfSetAsideDescription || opp.setAside || "";
  const agency = [opp.department, opp.subTier].filter(Boolean).join(" · ");

  return {
    external_id: opp.noticeId,
    source: "SAM.gov",
    source_url: opp.noticeId ? "https://sam.gov/opp/" + opp.noticeId + "/view" : opp.uiLink || null,
    title: opp.title || "Untitled opportunity",
    category: opp.type || opp.baseType || "Opportunity",
    geography: state,
    funding_amount: null,
    funding_amount_label: null,
    deadline: opp.responseDeadLine || null,
    requirements: "NAICS " + (opp.naicsCode || "—") + (setAside ? ", Set-aside: " + setAside : ""),
    summary: (agency ? agency + " — " : "") + "View the full notice on SAM.gov for complete requirements and attachments.",
  };
}

function dateWindow(lookbackDays) {
  function fmt(d) {
    var mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    var dd = String(d.getUTCDate()).padStart(2, "0");
    return mm + "/" + dd + "/" + d.getUTCFullYear();
  }
  var to = new Date();
  var from = new Date(to.getTime() - lookbackDays * 86400000);
  return { postedFrom: fmt(from), postedTo: fmt(to) };
}

/* ---------- Supabase REST helper (service role — bypasses RLS by design) ---------- */

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
