'use strict';
// Outbound email through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email).
// No SDK, matching the rest of the functions.
//
// Env vars:
//   RESEND_API_KEY  required to send. Without it every send is skipped and
//                   logged, so the app works the same until email is set up.
//   EMAIL_FROM      optional, default "Opportunity Assist <notifications@opportunityassist.com>".
//                   The domain must be verified in Resend.
const DEFAULT_FROM = 'Opportunity Assist <notifications@opportunityassist.com>';

function configured(env = process.env) {
  return !!env.RESEND_API_KEY;
}

async function sendEmail(message, { env = process.env, fetcher = (...a) => fetch(...a) } = {}) {
  if (!configured(env)) {
    console.log('email skipped (RESEND_API_KEY not set):', message.subject);
    return { skipped: true };
  }
  const to = [].concat(message.to || []).filter(Boolean);
  if (!to.length) return { skipped: true };
  const body = { from: env.EMAIL_FROM || DEFAULT_FROM, to, subject: message.subject, html: message.html, text: message.text };
  if (message.replyTo) body.reply_to = message.replyTo;
  if (message.headers) body.headers = message.headers;
  const r = await fetcher('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('Resend error (' + r.status + '): ' + (await r.text()).slice(0, 300));
  const data = await r.json().catch(() => ({}));
  return { id: data.id || null };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Plain, table-based layout with inline styles so it renders in every client.
function layout({ heading, intro, sections = [], footer = '' }) {
  const cell = 'font-family:Arial,Helvetica,sans-serif;color:#16242c;font-size:15px;line-height:1.5';
  const sectionHtml = sections.map((s) =>
    '<tr><td style="' + cell + ';padding:18px 0 6px"><strong style="font-size:16px">' + escapeHtml(s.title) + '</strong></td></tr>' +
    s.items.map((it) =>
      '<tr><td style="' + cell + ';padding:6px 0;border-top:1px solid #e3e8ea">' +
      (it.url ? '<a href="' + escapeHtml(it.url) + '" style="color:#0f5e63;font-weight:bold;text-decoration:none">' + escapeHtml(it.title) + '</a>' : '<strong>' + escapeHtml(it.title) + '</strong>') +
      (it.detail ? '<br><span style="color:#51606a;font-size:13px">' + escapeHtml(it.detail) + '</span>' : '') +
      '</td></tr>').join('') +
    (s.more ? '<tr><td style="' + cell + ';padding:6px 0;color:#51606a;font-size:13px">' + escapeHtml(s.more) + '</td></tr>' : '')
  ).join('');
  return '<!doctype html><html><body style="margin:0;padding:0;background:#f8f7f5">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f7f5"><tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px"><tr><td style="padding:24px 28px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
    '<tr><td style="' + cell + ';font-size:13px;color:#51606a;padding-bottom:6px">Opportunity Assist</td></tr>' +
    '<tr><td style="' + cell + ';font-size:20px;font-weight:bold;padding-bottom:8px">' + escapeHtml(heading) + '</td></tr>' +
    (intro ? '<tr><td style="' + cell + ';padding-bottom:4px">' + escapeHtml(intro) + '</td></tr>' : '') +
    sectionHtml +
    '</table></td></tr></table>' +
    (footer ? '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%"><tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#6b777f;padding:14px 28px">' + footer + '</td></tr></table>' : '') +
    '</td></tr></table></body></html>';
}

function textVersion({ heading, intro, sections = [], footerText = '' }) {
  return [heading, intro || ''].concat(sections.map((s) => s.title + '\n' + s.items.map((it) => '- ' + it.title + (it.detail ? ' (' + it.detail + ')' : '') + (it.url ? '\n  ' + it.url : '')).join('\n') + (s.more ? '\n' + s.more : ''))).concat(footerText ? [footerText] : []).join('\n\n');
}

module.exports = { sendEmail, configured, escapeHtml, layout, textVersion, DEFAULT_FROM };
