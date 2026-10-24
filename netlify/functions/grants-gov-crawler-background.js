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
// DETAILS. search2 returns only a title, agency, number and close date, so
// listings had no description and no award amount, and AI Fit Scores and
// summaries were written from the title alone. For each listing not yet
// enriched (or a forecast that has since been posted) the crawler now calls
// the public fetchOpportunity endpoint once and stores the synopsis text,
// award floor/ceiling, eligible applicant types, and a forecast's expected
// application date. Bounded per run (MAX_DETAILS) and paced (DETAIL_BATCH);
// failures fall back to the basic row and are retried on the next run.
// Enriched fields are never overwritten by later basic rows.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  writing to `opportunities` is a shared, global
//                              write, not something any signed-in user's own
//                              session should be able to do. Also used here
//                              to read every org's keywords -- a read no
//                              single signed-in session should have either.
//
// No API key needed for Grants.gov itself. Reuses the external_id column and
// unique index from docs/sam-gov-crawler-setup.sql, plus opportunities.
// detail_fetched_at (supabase/opportunity-assist migration, 2026-10-23).

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
// own keywords, deduped), so a single run stays bounded as subscribers grow.
const MAX_KEYWORDS = 200;
// Concurrent search2 calls; keeps this a well-behaved caller of a public API.
const BATCH_SIZE = 10;
const ROWS_PER_KEYWORD = 25;
// fetchOpportunity calls per run, and how many run at once. The first run
// works through the existing backlog over a few days; after that only new
// listings need details.
const MAX_DETAILS = 300;
const DETAIL_BATCH = 5;
const SUMMARY_MAX = 1800;
const SEARCH_URL = "https://api.grants.gov/v1/api/search2";
const DETAIL_URL = "https://api.grants.gov/v1/api/fetchOpportunity";

function makeHandler({ env = process.env, fetcher = (...a) => fetch(...a), now = () => new Date() } = {}) {
  const SUPABASE_URL = env.SUPABASE_URL;
  const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" });

  async function fetchOrgKeywords() {
    const r = await fetcher(SUPABASE_URL + "/rest/v1/organizations?select=keywords", { headers: sbHeaders() });
    if (!r.ok) throw new Error("organizations fetch failed: " + (await r.text()));
    const orgs = await r.json();
    const out = [];
    orgs.forEach((org) => { (org.keywords || []).forEach((k) => { if (k) out.push(k); }); });
    return out;
  }
  async function fetchExisting() {
    const out = {};
    for (let from = 0; ; from += 1000) {
      const r = await fetcher(SUPABASE_URL + "/rest/v1/opportunities?source=eq.Grants.gov&select=external_id,category,detail_fetched_at&order=external_id", {
        headers: Object.assign(sbHeaders(), { Range: from + "-" + (from + 999) }),
      });
      if (!r.ok) throw new Error("existing opportunities fetch failed: " + (await r.text()));
      const rows = await r.json();
      rows.forEach((row) => { out[row.external_id] = row; });
      if (rows.length < 1000) return out;
    }
  }
  async function fetchKeyword(keyword) {
    const r = await fetcher(SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: ROWS_PER_KEYWORD, keyword, oppStatuses: "forecasted|posted" }),
    });
    if (!r.ok) throw new Error("Grants.gov API error (" + r.status + "): " + (await r.text()).slice(0, 300));
    const json = await r.json();
    const hits = (json.data && json.data.oppHits) || json.oppHits || [];
    return hits.map(mapOpportunity).filter((o) => o.external_id);
  }
  async function fetchDetail(row) {
    const id = Number(String(row.external_id).replace("grantsgov-", ""));
    const r = await fetcher(DETAIL_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ opportunityId: id }) });
    if (!r.ok) throw new Error("fetchOpportunity " + id + " failed (" + r.status + ")");
    const json = await r.json();
    if (!json || !json.data || (json.errorcode && json.errorcode !== 0)) throw new Error("fetchOpportunity " + id + ": " + ((json && json.msg) || "no data"));
    return mapDetail(json.data, row);
  }
  async function sbUpsert(rows) {
    const r = await fetcher(SUPABASE_URL + "/rest/v1/opportunities?on_conflict=external_id", {
      method: "POST",
      headers: Object.assign(sbHeaders(), { Prefer: "resolution=merge-duplicates" }),
      body: JSON.stringify(rows),
    });
    if (!r.ok) throw new Error("opportunities upsert failed: " + (await r.text()));
  }

  return async () => {
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
    let fetched = 0, failed = 0;
    const rows = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") { fetched += r.value.length; rows.push(...r.value); }
      else { failed++; console.error("Keyword", finalKeywords[i], "fetch failed:", r.reason && r.reason.message); }
    });

    // De-dupe across overlapping keyword matches within this run.
    const byId = {};
    rows.forEach((row) => { byId[row.external_id] = row; });
    const unique = Object.values(byId);

    let existing = null;
    try { existing = await fetchExisting(); }
    catch (err) { console.error("Could not read existing Grants.gov rows; details skipped this run:", err.message); }

    // Which rows need details: never enriched, or a forecast that is now posted.
    const needDetail = existing ? unique.filter((row) => {
      const ex = existing[row.external_id];
      return !ex || !ex.detail_fetched_at || (ex.category === "Forecasted Grant" && row.category !== "Forecasted Grant");
    }).slice(0, MAX_DETAILS) : [];
    const detailResults = await runInBatches(needDetail, DETAIL_BATCH, fetchDetail);
    const enriched = {};
    let detailFailed = 0;
    detailResults.forEach((r, i) => {
      if (r.status === "fulfilled") enriched[needDetail[i].external_id] = Object.assign({}, r.value, { detail_fetched_at: now().toISOString() });
      else { detailFailed++; console.error("Detail", needDetail[i].external_id, "failed:", r.reason && r.reason.message); }
    });

    // Three uniform payload shapes (PostgREST bulk upserts need one key set):
    //   enriched now      -> full detail row (clears the cached AI summary so it is rewritten from the real text)
    //   new, no details   -> full basic row
    //   already enriched  -> only fields search2 is authoritative for, so the
    //                        stored description and amounts are not replaced
    const groups = { enriched: [], basic: [], refresh: [] };
    unique.forEach((row) => {
      if (enriched[row.external_id]) groups.enriched.push(enriched[row.external_id]);
      else if (existing && existing[row.external_id] && existing[row.external_id].detail_fetched_at) groups.refresh.push(refreshFields(row));
      else groups.basic.push(row);
    });

    let upserted = 0;
    for (const name of Object.keys(groups)) {
      const list = groups[name];
      for (let i = 0; i < list.length; i += 200) {
        const batch = list.slice(i, i + 200);
        try { await sbUpsert(batch); upserted += batch.length; }
        catch (err) { failed += batch.length; console.error("Upsert batch (" + name + ") failed:", err.message); }
      }
    }

    const summary = { keywordsSearched: finalKeywords.length, fetched, unique: unique.length, detailsFetched: Object.keys(enriched).length, detailFailed, detailBacklogCapped: existing ? Math.max(0, unique.filter((row) => !existing[row.external_id] || !existing[row.external_id].detail_fetched_at).length - MAX_DETAILS) : null, upserted, failed };
    console.log("Grants.gov crawl done:", summary);
    return summary;
  };
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

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");
// Grants.gov uses several date shapes: "12/15/2026" (search2), "2026-12-15-00-00-00"
// (...Str fields) and "Dec 15, 2026 12:00:00 AM EST" (display fields).
function parseGrantsDate(value) {
  const v = String(value || "").trim();
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + "-" + pad(m[1]) + "-" + pad(m[2]);
  m = v.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return m[3] + "-" + pad(MONTHS[m[1].toLowerCase()]) + "-" + pad(m[2]);
  return null;
}
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "-", mdash: ", " };
function stripHtml(html) {
  return String(html || "")
    .replace(/<(br|\/p|\/li|\/div|\/h\d)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|[a-z]+);/gi, (all, e) => (e[0] === "#" ? String.fromCharCode(Number(e.slice(1))) : ENTITIES[e.toLowerCase()] != null ? ENTITIES[e.toLowerCase()] : all))
    .replace(/\s+/g, " ")
    .trim();
}
function money(n) { return "$" + Math.round(n).toLocaleString("en-US"); }
function amount(v) {
  const n = Number(String(v == null ? "" : v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}
function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return (stop > max * 0.6 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, "")) + " (continued on Grants.gov)";
}

function mapOpportunity(hit) {
  const id = hit.id || hit.oppId || hit.opportunityId;
  const number = hit.number || hit.oppNumber || hit.opportunityNumber || "";
  const title = hit.title || hit.opportunityTitle || "Untitled opportunity";
  const agency = hit.agencyName || hit.agency || hit.agencyCode || "";
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
    deadline: parseGrantsDate(hit.closeDate || hit.responseDate) || null,
    requirements: "Opportunity number " + (number || "not listed") + (agency ? ", posted by " + agency : ""),
    summary: (agency ? agency + ": " : "") + "View the full notice on Grants.gov for complete eligibility, requirements, and application details.",
  };
}

// Fields search2 is authoritative for on rows that already have details.
function refreshFields(row) {
  return { external_id: row.external_id, source: row.source, source_url: row.source_url, title: row.title, category: row.category, deadline: row.deadline };
}

// data: the fetchOpportunity "data" object. base: the mapped search2 row.
function mapDetail(data, base) {
  const syn = data.synopsis || null;
  const fc = data.forecast || null;
  const src = syn || fc || {};
  const agency = src.agencyName || (data.agencyDetails && data.agencyDetails.agencyName) || "";
  const desc = stripHtml(src.synopsisDesc || src.forecastDesc || "");
  const floor = amount(src.awardFloor), ceiling = amount(src.awardCeiling), total = amount(src.estimatedFunding);
  const label = floor && ceiling && floor !== ceiling ? money(floor) + " to " + money(ceiling) : ceiling ? "Up to " + money(ceiling) : floor ? "From " + money(floor) : null;
  const applicants = (src.applicantTypes || []).map((t) => t && t.description).filter(Boolean);
  const eligibilityText = stripHtml(src.applicantEligibilityDesc || "");
  const expected = !syn && fc ? parseGrantsDate(fc.estApplicationResponseDateStr || fc.estApplicationResponseDate) : null;
  const deadline = parseGrantsDate(src.responseDateStr || src.responseDate) || base.deadline || null;
  const number = data.opportunityNumber || "";
  const extras = [];
  if (expected) extras.push("Forecast: applications expected around " + expected + ".");
  if (total) extras.push("Estimated total program funding: " + money(total) + ".");
  if (src.costSharing === true) extras.push("Cost sharing or matching is required.");
  const reqParts = ["Opportunity number " + (number || "not listed") + (agency ? ", posted by " + agency : "") + "."];
  if (applicants.length) reqParts.push("Eligible applicants: " + applicants.join("; ") + ".");
  if (eligibilityText) reqParts.push(clip(eligibilityText, 600));
  return {
    external_id: base.external_id,
    source: base.source,
    source_url: base.source_url,
    title: data.opportunityTitle || base.title,
    category: syn ? "Grant Opportunity" : fc ? "Forecasted Grant" : base.category,
    geography: base.geography,
    funding_amount: ceiling || floor || null,
    funding_amount_label: label,
    deadline: syn ? deadline : base.deadline,
    requirements: reqParts.join(" "),
    summary: clip([(agency ? agency + ": " : "") + (desc || "No description provided on Grants.gov.")].concat(extras).join(" "), SUMMARY_MAX),
    ai_summary: null,
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
exports._test = { mapOpportunity, mapDetail, parseGrantsDate, stripHtml, refreshFields };
