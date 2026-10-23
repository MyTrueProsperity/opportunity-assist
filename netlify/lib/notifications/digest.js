'use strict';
// Builds and sends the daily digest: new alert matches (current leads that
// match an organization's active alert rules and were never emailed before)
// and reminders for open Capture Pipeline items due in 14, 7, 3 or 1 days.
// Pure planning is separated from I/O so it can be tested without a database.
const crypto = require('node:crypto');
const M = require('../../../assets/matching');
const A = require('../../../assets/alerts');
const W = require('../../../assets/opportunity-workflow');
const email = require('./email');

const REMINDER_DAYS = [14, 7, 3, 1];
const CLOSED_STAGES = ['Awarded', 'Not Awarded'];
const MAX_ITEMS = 10;

function unsubscribeToken(secret, userId) {
  return crypto.createHmac('sha256', String(secret)).update('digest-unsubscribe:' + userId).digest('hex');
}
function validUnsubscribe(secret, userId, token) {
  if (!secret || !userId || !/^[0-9a-f]{64}$/.test(String(token || ''))) return false;
  const expected = Buffer.from(unsubscribeToken(secret, userId), 'hex');
  return crypto.timingSafeEqual(expected, Buffer.from(String(token), 'hex'));
}

// data: { org, rules, opps, fitById, pipeline, decisions, sent:Set("kind:key") }
function planOrg(data, today) {
  const { org, rules = [], opps = [], fitById = {}, pipeline = [], decisions = {}, sent = new Set() } = data;
  const captured = new Set(pipeline.map((p) => p.opportunity_id).filter(Boolean));
  const matches = rules.some((r) => r.active !== false)
    ? A.matchingOpportunities(rules, opps.filter((o) =>
        M.eligibility(org, o, today).status !== 'INELIGIBLE' && !captured.has(o.id) && decisions[o.id] !== 'pass' && !sent.has('alert_match:' + o.id)),
      (o) => fitById[o.id] || null)
    : [];
  matches.sort((a, b) => String(a.deadline || '9999').localeCompare(String(b.deadline || '9999')));
  const deadlines = [];
  pipeline.forEach((p) => {
    if (CLOSED_STAGES.indexOf(p.stage) !== -1) return;
    const due = p.deadline || (p.opportunities && p.opportunities.deadline);
    const days = W.daysUntil(due, today);
    if (REMINDER_DAYS.indexOf(days) === -1) return;
    const key = p.id + ':' + days;
    if (sent.has('deadline:' + key)) return;
    deadlines.push({ key, title: p.title, stage: p.stage, due: String(due).slice(0, 10), days });
  });
  deadlines.sort((a, b) => a.days - b.days);
  return { matches, deadlines };
}

function compose(org, plan, { appUrl, unsubscribeUrl }) {
  const sections = [];
  if (plan.deadlines.length) sections.push({
    title: 'Pipeline deadlines',
    items: plan.deadlines.map((d) => ({ title: d.title, detail: (d.days === 1 ? 'Due tomorrow' : 'Due in ' + d.days + ' days') + ' (' + d.due + ') · ' + d.stage, url: appUrl })),
  });
  if (plan.matches.length) sections.push({
    title: 'New leads matching your alerts',
    items: plan.matches.slice(0, MAX_ITEMS).map((o) => ({
      title: o.title,
      detail: [o.category, o.funding_amount_label, o.deadline ? 'Due ' + String(o.deadline).slice(0, 10) : 'No deadline listed'].filter(Boolean).join(' · '),
      url: /^https?:\/\//i.test(o.source_url || '') ? o.source_url : appUrl,
    })),
    more: plan.matches.length > MAX_ITEMS ? 'And ' + (plan.matches.length - MAX_ITEMS) + ' more in Alerts.' : '',
  });
  const parts = [];
  if (plan.matches.length) parts.push(plan.matches.length + (plan.matches.length === 1 ? ' new lead' : ' new leads'));
  if (plan.deadlines.length) parts.push(plan.deadlines.length + (plan.deadlines.length === 1 ? ' deadline' : ' deadlines'));
  const subject = org.name + ': ' + parts.join(' and ');
  const heading = 'Today for ' + org.name;
  const intro = 'Leads are worth a look, not confirmed eligible. Check each source before you invest time.';
  const footer = 'You get this because you belong to ' + email.escapeHtml(org.name) + ' in Opportunity Assist. ' +
    '<a href="' + email.escapeHtml(appUrl) + '" style="color:#0f5e63">Open Opportunity Assist</a> · ' +
    '<a href="' + email.escapeHtml(unsubscribeUrl) + '" style="color:#0f5e63">Stop these emails</a>';
  return {
    subject,
    html: email.layout({ heading, intro, sections, footer }),
    text: email.textVersion({ heading, intro, sections, footerText: 'Open Opportunity Assist: ' + appUrl + '\nStop these emails: ' + unsubscribeUrl }),
  };
}

function makeDigest({ env = process.env, fetcher = (...a) => fetch(...a), today = () => W.day(new Date(), 'America/New_York') } = {}) {
  const URL_ = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  const APP_URL = (env.APP_URL || 'https://opportunityassist.com').replace(/\/$/, '');
  const headers = (extra) => Object.assign({ apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, extra || {});
  async function select(table, query) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const r = await fetcher(URL_ + '/rest/v1/' + table + '?' + query, { headers: headers({ Range: from + '-' + (from + 999) }) });
      if (!r.ok) throw new Error(table + ' select failed: ' + (await r.text()));
      const rows = await r.json();
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  }
  async function logSent(rows) {
    if (!rows.length) return;
    const r = await fetcher(URL_ + '/rest/v1/notification_log?on_conflict=org_id,kind,item_key', { method: 'POST', headers: headers({ Prefer: 'resolution=ignore-duplicates' }), body: JSON.stringify(rows) });
    if (!r.ok) throw new Error('notification_log insert failed: ' + (await r.text()));
  }

  return async function run() {
    if (!URL_ || !KEY) { console.error('digest misconfigured: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'); return { skipped: 'config' }; }
    if (!email.configured(env)) { console.log('digest skipped: RESEND_API_KEY not set'); return { skipped: 'email' }; }
    const asOf = today();
    const [orgs, memberships, profiles, rules, opps, pipeline, decisions, sentRows] = await Promise.all([
      select('organizations', 'select=id,name,service_areas,keywords&order=id'),
      select('org_memberships', 'select=org_id,user_id&order=org_id,user_id'),
      select('profiles', 'select=id,email,email_digest&email=not.is.null&email_digest=is.true&order=id'),
      select('alert_rules', 'select=*&active=is.true&order=id'),
      select('opportunities', 'select=id,title,summary,category,requirements,geography,deadline,source_active,funding_amount,funding_amount_label,source_url&source_active=not.is.false&or=(deadline.is.null,deadline.gte.' + asOf + ')&order=id'),
      select('pipeline_items', 'select=id,org_id,opportunity_id,title,stage,deadline,opportunities(deadline)&order=id'),
      select('pursue_decisions', 'select=org_id,opportunity_id,decision,decided_at&order=decided_at.desc'),
      select('notification_log', 'select=org_id,kind,item_key&order=org_id'),
    ]);
    const people = {};
    profiles.forEach((p) => { if (p.email && p.email_digest !== false) people[p.id] = p; });
    const summary = { orgs: 0, emails: 0, matches: 0, deadlines: 0, failures: 0 };
    for (const org of orgs) {
      const recipients = memberships.filter((m) => m.org_id === org.id && people[m.user_id]).map((m) => people[m.user_id]);
      if (!recipients.length) continue;
      const orgRules = rules.filter((r) => r.org_id === org.id);
      const orgPipeline = pipeline.filter((p) => p.org_id === org.id);
      if (!orgRules.length && !orgPipeline.length) continue;
      let fitById = {};
      if (orgRules.some((r) => r.min_score != null)) {
        const fits = await select('fit_scores', 'select=opportunity_id,headline_score,eligibility_status,source_stale,rubric_version&org_id=eq.' + org.id + '&order=opportunity_id');
        fits.forEach((f) => { if (!f.source_stale && f.rubric_version === M.RUBRIC_VERSION) fitById[f.opportunity_id] = f; });
      }
      const latest = {};
      decisions.forEach((d) => { if (d.org_id === org.id && !(d.opportunity_id in latest)) latest[d.opportunity_id] = d.decision; });
      const sent = new Set(sentRows.filter((s) => s.org_id === org.id).map((s) => s.kind + ':' + s.item_key));
      const plan = planOrg({ org, rules: orgRules, opps, fitById, pipeline: orgPipeline, decisions: latest, sent }, asOf);
      if (!plan.matches.length && !plan.deadlines.length) continue;
      let delivered = 0;
      for (const person of recipients) {
        const unsubscribeUrl = APP_URL + '/.netlify/functions/notifications-unsubscribe?u=' + encodeURIComponent(person.id) + '&t=' + unsubscribeToken(KEY, person.id);
        const msg = compose(org, plan, { appUrl: APP_URL + '/app.html', unsubscribeUrl });
        try {
          await email.sendEmail({ to: person.email, subject: msg.subject, html: msg.html, text: msg.text, headers: { 'List-Unsubscribe': '<' + unsubscribeUrl + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }, { env, fetcher });
          delivered++;
        } catch (err) {
          summary.failures++;
          console.error('digest email failed for org', org.id, err.message);
        }
      }
      if (!delivered) continue;
      await logSent(plan.matches.map((o) => ({ org_id: org.id, kind: 'alert_match', item_key: o.id }))
        .concat(plan.deadlines.map((d) => ({ org_id: org.id, kind: 'deadline', item_key: d.key }))));
      summary.orgs++; summary.emails += delivered; summary.matches += plan.matches.length; summary.deadlines += plan.deadlines.length;
    }
    console.log('digest done:', summary);
    return summary;
  };
}

module.exports = { planOrg, compose, makeDigest, unsubscribeToken, validUnsubscribe, REMINDER_DAYS };
