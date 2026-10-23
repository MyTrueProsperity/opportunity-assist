"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeHandler, _test: G } = require("../netlify/functions/grants-gov-crawler-background");

const posted = { id: 360001, number: "ED-GRANTS-2026-01", title: "Youth Workforce Pathways", agencyName: "Department of Education", oppStatus: "posted", closeDate: "12/15/2026" };
const forecast = { id: 360002, number: "DOL-FC-01", title: "Financial Capability for Young Adults", agencyName: "Department of Labor", oppStatus: "forecasted", closeDate: "" };
const known = { id: 360003, number: "HHS-1", title: "Already enriched grant", agencyName: "HHS", oppStatus: "posted", closeDate: "01/20/2027" };
const detail = {
  360001: { id: 360001, opportunityNumber: "ED-GRANTS-2026-01", opportunityTitle: "Youth Workforce Pathways", synopsis: {
    agencyName: "Department of Education", synopsisDesc: "<p>Supports <b>paid work experience</b> for youth ages 16&ndash;24.</p><br>Applicants must partner with employers.",
    awardCeiling: "500000", awardFloor: "100000", estimatedFunding: "12000000", responseDate: "Dec 15, 2026 12:00:00 AM EST", responseDateStr: "2026-12-15-00-00-00",
    costSharing: true, applicantTypes: [{ id: "12", description: "Nonprofits having a 501(c)(3) status with the IRS, other than institutions of higher education" }],
    applicantEligibilityDesc: "Local workforce boards may also apply." } },
  360002: { id: 360002, opportunityNumber: "DOL-FC-01", opportunityTitle: "Financial Capability for Young Adults", forecast: {
    agencyName: "Department of Labor", forecastDesc: "Expected program for financial coaching.", awardCeiling: "none", estApplicationResponseDate: "Mar 3, 2027", applicantTypes: [] } },
};

test("dates in every Grants.gov format become ISO dates", () => {
  assert.equal(G.parseGrantsDate("12/15/2026"), "2026-12-15");
  assert.equal(G.parseGrantsDate("2026-12-15-00-00-00"), "2026-12-15");
  assert.equal(G.parseGrantsDate("Dec 5, 2026 12:00:00 AM EST"), "2026-12-05");
  assert.equal(G.parseGrantsDate(""), null);
  assert.equal(G.parseGrantsDate("TBD"), null);
});

test("a posted notice yields a real description, award range, applicants and no em dashes", () => {
  const row = G.mapDetail(detail[360001], G.mapOpportunity(posted));
  assert.equal(row.funding_amount, 500000);
  assert.equal(row.funding_amount_label, "$100,000 to $500,000");
  assert.equal(row.deadline, "2026-12-15");
  assert.match(row.summary, /^Department of Education: Supports paid work experience for youth ages 16-24\. Applicants must partner with employers\./);
  assert.match(row.summary, /Estimated total program funding: \$12,000,000\. Cost sharing or matching is required\./);
  assert.match(row.requirements, /Eligible applicants: Nonprofits having a 501\(c\)\(3\)/);
  assert.match(row.requirements, /Local workforce boards may also apply\./);
  assert.equal(row.ai_summary, null, "the cached AI summary is rewritten from the real text");
  assert.doesNotMatch(row.summary + row.requirements + G.mapOpportunity(posted).summary, /—/);
});

test("a forecast keeps no hard deadline but states the expected date", () => {
  const row = G.mapDetail(detail[360002], G.mapOpportunity(forecast));
  assert.equal(row.category, "Forecasted Grant");
  assert.equal(row.deadline, null);
  assert.equal(row.funding_amount, null, "'none' is not an amount");
  assert.match(row.summary, /Forecast: applications expected around 2027-03-03\./);
});

test("a run enriches new listings once and never overwrites stored details with bare search results", async () => {
  const upserts = [], detailCalls = [];
  const fetcher = async (url, init = {}) => {
    const ok = (body) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.includes("/organizations?")) return ok([{ keywords: ["youth employment"] }]);
    if (url.includes("/opportunities?source=eq.Grants.gov")) return ok([{ external_id: "grantsgov-360003", category: "Grant Opportunity", detail_fetched_at: "2026-10-20T00:00:00Z" }]);
    if (url.endsWith("/search2")) return ok({ data: { oppHits: [posted, forecast, known] } });
    if (url.endsWith("/fetchOpportunity")) { const id = JSON.parse(init.body).opportunityId; detailCalls.push(id); return ok({ errorcode: 0, data: detail[id] }); }
    if (url.includes("/opportunities?on_conflict=external_id")) { upserts.push(JSON.parse(init.body)); return ok([]); }
    throw Error("unexpected " + url);
  };
  const summary = await makeHandler({ env: { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "svc" }, fetcher, now: () => new Date("2026-10-23T09:10:00Z") })();
  assert.deepEqual(detailCalls.sort(), [360001, 360002], "the already-enriched listing is not fetched again");
  assert.equal(summary.detailsFetched, 2);
  for (const batch of upserts) {
    const keys = JSON.stringify(Object.keys(batch[0]).sort());
    assert.ok(batch.every((r) => JSON.stringify(Object.keys(r).sort()) === keys), "each bulk upsert has one key set");
  }
  const all = upserts.flat();
  const knownRow = all.find((r) => r.external_id === "grantsgov-360003");
  assert.ok(!("summary" in knownRow) && !("funding_amount" in knownRow) && !("requirements" in knownRow), "stored details are left alone");
  assert.equal(knownRow.deadline, "2027-01-20");
  assert.equal(all.find((r) => r.external_id === "grantsgov-360001").detail_fetched_at, "2026-10-23T09:10:00.000Z");
});

test("detail failures fall back to the basic row and are retried later", async () => {
  const upserts = [];
  const fetcher = async (url, init = {}) => {
    const ok = (body) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.includes("/organizations?")) return ok([]);
    if (url.includes("/opportunities?source=eq.Grants.gov")) return ok([]);
    if (url.endsWith("/search2")) return ok({ data: { oppHits: [posted] } });
    if (url.endsWith("/fetchOpportunity")) return { ok: false, status: 503, json: async () => ({}), text: async () => "busy" };
    if (url.includes("on_conflict")) { upserts.push(...JSON.parse(init.body)); return ok([]); }
    throw Error("unexpected " + url);
  };
  const summary = await makeHandler({ env: { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "svc" }, fetcher })();
  assert.equal(summary.detailFailed, 1);
  const row = upserts.find((r) => r.external_id === "grantsgov-360001");
  assert.equal(row.deadline, "2026-12-15");
  assert.ok(!("detail_fetched_at" in row), "not marked as enriched, so the next run tries again");
});
