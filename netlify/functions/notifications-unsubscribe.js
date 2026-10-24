'use strict';
// One-click unsubscribe from the daily digest. The link in each email carries
// the person's id and an HMAC of it (keyed with the service role key, which
// never leaves the server), so nobody can turn off someone else's email.
// GET shows a confirmation page; POST supports one-click List-Unsubscribe.
const { validUnsubscribe } = require('../lib/notifications/digest');

function page(title, body, status) {
  return { statusCode: status || 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + title + '</title></head>' +
      '<body style="font-family:Arial,Helvetica,sans-serif;background:#f8f7f5;color:#16242c;margin:0;padding:40px 16px"><div style="max-width:520px;margin:0 auto;background:#fff;border-radius:8px;padding:28px">' +
      '<p style="color:#51606a;margin:0 0 8px">Opportunity Assist</p><h1 style="font-size:22px;margin:0 0 12px">' + title + '</h1><p style="line-height:1.5">' + body + '</p></div></body></html>' };
}

function makeHandler({ env = process.env, fetcher = (...a) => fetch(...a) } = {}) {
  return async (event) => {
    const q = event.queryStringParameters || {};
    if (!['GET', 'POST'].includes(event.httpMethod)) return page('Not allowed', 'Use the link in your email.', 405);
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return page('Something went wrong', 'Please email bill@mytrueprosperity.com and we will turn these emails off.', 500);
    if (!validUnsubscribe(env.SUPABASE_SERVICE_ROLE_KEY, q.u, q.t)) return page('Link not recognized', 'This link is incomplete or was changed. You can turn the daily email off on the Organization page in Opportunity Assist.', 400);
    const r = await fetcher(env.SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(q.u), {
      method: 'PATCH',
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email_digest: false }),
    });
    if (!r.ok) { console.error('unsubscribe failed:', await r.text()); return page('Something went wrong', 'Please try again, or email bill@mytrueprosperity.com.', 500); }
    return page('You are unsubscribed', 'You will not get the daily Opportunity Assist email. You can turn it back on any time on the Organization page.');
  };
}
exports.handler = makeHandler();
exports.makeHandler = makeHandler;
