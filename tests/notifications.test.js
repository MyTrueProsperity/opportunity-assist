"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const email = require("../netlify/lib/notifications/email");
const D = require("../netlify/lib/notifications/digest");
const M = require("../assets/matching");
const { coreDb, BILL, MTP } = require("./helpers/core-db");

const TODAY = "2026-10-23";
const org = { id: "org1", name: "Synthetic Youth Org", service_areas: "Florida" };
const opp = (id, extra = {}) => ({ id, title: id, summary: "", category: "Grant Opportunity", geography: "Florida", requirements: "x", deadline: "2026-12-01", source_url: "https://example.org/" + id, ...extra });

test("email is skipped, not failed, until RESEND_API_KEY is set", async () => {
  let called = false;
  const r = await email.sendEmail({ to: "a@example.org", subject: "x", html: "x" }, { env: {}, fetcher: async () => { called = true; } });
  assert.deepEqual(r, { skipped: true });
  assert.equal(called, false);
});

test("email goes to Resend with the configured sender and reply-to", async () => {
  let sent;
  const r = await email.sendEmail({ to: "a@example.org", subject: "Hi", html: "<p>x</p>", text: "x", replyTo: "b@example.org" },
    { env: { RESEND_API_KEY: "re_test" }, fetcher: async (url, init) => { sent = { url, init }; return { ok: true, json: async () => ({ id: "em_1" }) }; } });
  assert.equal(r.id, "em_1");
  assert.equal(sent.url, "https://api.resend.com/emails");
  assert.equal(sent.init.headers.Authorization, "Bearer re_test");
  const body = JSON.parse(sent.init.body);
  assert.equal(body.from, email.DEFAULT_FROM);
  assert.deepEqual(body.to, ["a@example.org"]);
  assert.equal(body.reply_to, "b@example.org");
});

test("the digest plan finds new matches and deadline reminders, never repeats, and skips passed, captured and closed leads", () => {
  const rules = [{ org_id: "org1", keywords: ["youth"], active: true }];
  const opps = [opp("youth jobs"), opp("youth closed", { deadline: "2026-10-01" }), opp("youth passed"), opp("youth captured"), opp("youth sent"), opp("adult literacy"), opp("youth other state", { geography: "Ohio" })];
  const pipeline = [
    { id: "p1", org_id: "org1", opportunity_id: "youth captured", title: "Captured", stage: "Writing", deadline: null, opportunities: { deadline: "2026-10-30" } },
    { id: "p2", org_id: "org1", opportunity_id: null, title: "Due tomorrow", stage: "Planning", deadline: "2026-10-24", opportunities: null },
    { id: "p3", org_id: "org1", opportunity_id: null, title: "Won already", stage: "Awarded", deadline: "2026-10-24", opportunities: null },
    { id: "p4", org_id: "org1", opportunity_id: null, title: "Due in 5", stage: "Ideas", deadline: "2026-10-28", opportunities: null },
  ];
  const plan = D.planOrg({ org, rules, opps, pipeline, decisions: { "youth passed": "pass" }, sent: new Set(["alert_match:youth sent"]) }, TODAY);
  assert.deepEqual(plan.matches.map((o) => o.id), ["youth jobs"]);
  assert.deepEqual(plan.deadlines.map((d) => [d.title, d.days]), [["Due tomorrow", 1], ["Captured", 7]]);
  const again = D.planOrg({ org, rules, opps, pipeline, decisions: { "youth passed": "pass" }, sent: new Set(["alert_match:youth sent", "alert_match:youth jobs", "deadline:p2:1", "deadline:p1:7"]) }, TODAY);
  assert.equal(again.matches.length + again.deadlines.length, 0, "nothing is emailed twice");
});

test("fit-score alert rules use real current scores only", () => {
  const rules = [{ org_id: "org1", min_score: 75, active: true }];
  const plan = D.planOrg({ org, rules, opps: [opp("a"), opp("b"), opp("c")], fitById: { a: { headline_score: 80, eligibility_status: "ELIGIBLE" }, b: { headline_score: 60, eligibility_status: "ELIGIBLE" } }, pipeline: [] }, TODAY);
  assert.deepEqual(plan.matches.map((o) => o.id), ["a"]);
});

test("the email is plain, escapes listing text, links an unsubscribe, and has no em dashes", () => {
  const plan = { matches: [opp("<b>Youth</b> & Families", { funding_amount_label: "Up to $50,000" })], deadlines: [{ key: "p2:1", title: "Summer RFP", stage: "Writing", due: "2026-10-24", days: 1 }] };
  const msg = D.compose(org, plan, { appUrl: "https://opportunityassist.com/app.html", unsubscribeUrl: "https://opportunityassist.com/.netlify/functions/notifications-unsubscribe?u=1&t=2" });
  assert.equal(msg.subject, "Synthetic Youth Org: 1 new lead and 1 deadline");
  assert.match(msg.html, /&lt;b&gt;Youth&lt;\/b&gt; &amp; Families/);
  assert.match(msg.html, /Due tomorrow \(2026-10-24\) · Writing/);
  assert.match(msg.html, /notifications-unsubscribe\?u=1&amp;t=2/);
  assert.match(msg.text, /Stop these emails: https:\/\/opportunityassist.com/);
  assert.doesNotMatch(msg.html + msg.text, /—/);
});

test("unsubscribe links cannot be forged or reused for someone else", () => {
  const t = D.unsubscribeToken("svc", "user-1");
  assert.equal(D.validUnsubscribe("svc", "user-1", t), true);
  assert.equal(D.validUnsubscribe("svc", "user-2", t), false);
  assert.equal(D.validUnsubscribe("other", "user-1", t), false);
  assert.equal(D.validUnsubscribe("svc", "user-1", "abc"), false);
});

test("a full digest run emails opted-in members once and records what was sent", async () => {
  const sentMail = [], logged = [];
  const tables = {
    organizations: [org],
    org_memberships: [{ org_id: "org1", user_id: "u1" }, { org_id: "org1", user_id: "u2" }, { org_id: "org1", user_id: "guest" }],
    profiles: [{ id: "u1", email: "one@example.org", email_digest: true }],
    alert_rules: [{ id: "r1", org_id: "org1", keywords: ["youth"], active: true }],
    opportunities: [opp("youth jobs")],
    pipeline_items: [], pursue_decisions: [], notification_log: [],
  };
  const fetcher = async (url, init = {}) => {
    const ok = (body) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
    if (url === "https://api.resend.com/emails") { sentMail.push(JSON.parse(init.body)); return ok({ id: "em" }); }
    const table = new URL(url).pathname.split("/").pop();
    if (init.method === "POST" && table === "notification_log") { logged.push(...JSON.parse(init.body)); return ok([]); }
    return ok(tables[table] || []);
  };
  const env = { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "svc", RESEND_API_KEY: "re_test" };
  const summary = await D.makeDigest({ env, fetcher, today: () => TODAY })();
  assert.equal(summary.emails, 1, "only the member with an email who has the digest on");
  assert.deepEqual(sentMail[0].to, ["one@example.org"]);
  assert.match(sentMail[0].headers["List-Unsubscribe"], /notifications-unsubscribe\?u=u1&t=[0-9a-f]{64}/);
  assert.deepEqual(logged, [{ org_id: "org1", kind: "alert_match", item_key: "youth jobs" }]);
  const skipped = await D.makeDigest({ env: { ...env, RESEND_API_KEY: "" }, fetcher, today: () => TODAY })();
  assert.deepEqual(skipped, { skipped: "email" }, "nothing is marked as sent before email is set up");
});

test("the unsubscribe endpoint turns the digest off only with a valid link", async () => {
  const { makeHandler } = require("../netlify/functions/notifications-unsubscribe");
  const patches = [];
  const h = makeHandler({ env: { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "svc" }, fetcher: async (url, init) => { patches.push({ url, body: JSON.parse(init.body) }); return { ok: true, text: async () => "" }; } });
  const bad = await h({ httpMethod: "GET", queryStringParameters: { u: "u1", t: D.unsubscribeToken("svc", "u2") } });
  assert.equal(bad.statusCode, 400);
  assert.equal(patches.length, 0);
  const good = await h({ httpMethod: "POST", queryStringParameters: { u: "u1", t: D.unsubscribeToken("svc", "u1") } });
  assert.equal(good.statusCode, 200);
  assert.deepEqual(patches[0], { url: "https://sb.test/rest/v1/profiles?id=eq.u1", body: { email_digest: false } });
});

test("early-access requests are saved, then emailed to Bill with reply-to set; an email failure does not fail the request", async () => {
  const { makeHandler } = require("../netlify/functions/request-early-access");
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); if (url.includes("resend")) return { ok: false, status: 500, text: async () => "down" }; return { ok: true, text: async () => "" }; };
  const res = await makeHandler({ env: { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "svc", RESEND_API_KEY: "re" }, fetcher })({ httpMethod: "POST", body: JSON.stringify({ name: "Ana", email: "ana@example.org", organization: "Youth Org", message: "Summer jobs" }) });
  assert.equal(res.statusCode, 200);
  assert.match(calls[0].url, /early_access_requests$/);
  assert.equal(calls[1].body.reply_to, "ana@example.org");
  assert.deepEqual(calls[1].body.to, ["bill@mytrueprosperity.com"]);
  assert.equal(calls[1].body.subject, "Opportunity Assist request: Youth Org");
});

test("the digest columns exist with safe defaults and the send log is closed to signed-in users", async () => {
  const { pg, as } = await coreDb();
  assert.equal((await pg.query("select email_digest from profiles where id=$1", [BILL])).rows[0].email_digest, true);
  await as(BILL, ({ q }) => q("update profiles set email_digest=false where id=$1", [BILL]));
  assert.equal((await pg.query("select email_digest from profiles where id=$1", [BILL])).rows[0].email_digest, false);
  await assert.rejects(as(BILL, ({ q }) => q("select * from notification_log")), /permission denied/);
  await pg.query("insert into notification_log(org_id,kind,item_key) values ($1,'deadline','p1:7')", [MTP]);
  await assert.rejects(pg.query("insert into notification_log(org_id,kind,item_key) values ($1,'deadline','p1:7')", [MTP]), /duplicate key/);
  await pg.close();
});
