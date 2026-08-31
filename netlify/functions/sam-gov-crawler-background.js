// netlify/functions/sam-gov-crawler-background.js
//
// Daily SAM.gov opportunity crawler for Opportunity Assist. Populates the
// shared `opportunities` table that every organization's Funding Radar reads
// from. Runs on a schedule (see netlify.toml) as a Background Function --
// several sequential SAM.gov + Supabase calls can run past the 10s limit on
// a regular synchronous function, and background functions get up to 15 min.
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
//                              session should be able to do.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SAM_API_KEY = process.env.SAM_GOV_API_KEY;

// Starter NAICS list matching workforce development, financial capability,
// youth employment, VITA/CRA-adjacent, and community-prosperity work. Edit
// freely -- this is the single biggest lever on how relevant the Funding
// Radar feels, more than anything else in this file.
const NAICS_CODES = [
  "611430", // Professional and Management Development Training
  "611710", // Educational Support Services
  "624190", // Other Individual and Family Services
  "624310", // Vocational Rehabilitation Services
  "813219", // Other Grantmaking and Giving Services
  "813319", // Other Social Advocacy Organizations
];

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
  console.log("SAM.gov crawl:", postedFrom, "to", postedTo, "across", NAICS_CODES.length, "NAICS codes");

  const results = await Promise.allSettled(NAICS_CODES.map((code) => fetchNaicsCode(code, postedFrom, postedTo)));

  let fetched = 0;
  let failed = 0;
  const rows = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      fetched += r.value.length;
      rows.push(...r.value);
    } else {
      failed++;
      console.error("NAICS", NAICS_CODES[i], "fetch failed:", r.reason && r.reason.message);
    }
  });

  // De-dupe across overlapping NAICS matches within this run before upserting.
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

async function fetchNaicsCode(ncode, postedFrom, postedTo) {
  const rows = [];
  let offset = 0;
  const limit = 1000;
  // Defensive cap: bail after 5 pages (5,000 records) for a single NAICS
  // code in one run rather than looping indefinitely on a bad response.
  for (let page = 0; page < 5; page++) {
    const url =
      "https://api.sam.gov/opportunities/v2/search?" +
      new URLSearchParams({
        api_key: SAM_API_KEY,
        postedFrom,
        postedTo,
        ncode,
        ptype: PTYPES,
        limit: String(limit),
        offset: String(offset),
      }).toString();

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
