'use strict';
// Scheduled daily (see netlify.toml). Emails each organization's members who
// have the digest turned on: new alert matches and pipeline deadline
// reminders. Does nothing until RESEND_API_KEY is set.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, optional EMAIL_FROM, APP_URL.
const { makeDigest } = require('../lib/notifications/digest');
exports.handler = async () => {
  if (process.env.NETLIFY === 'true' && process.env.CONTEXT !== 'production') return;
  await makeDigest()();
};
