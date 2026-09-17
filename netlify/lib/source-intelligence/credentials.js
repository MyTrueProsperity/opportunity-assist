'use strict';
const { createHash, randomBytes } = require('node:crypto');
const { HttpError } = require('./db');

const TOKEN_PREFIX = 'oa_live_';
const hashToken = token => createHash('sha256').update(String(token)).digest('hex');

// Generates a new plaintext credential. The caller must show this to the
// admin exactly once -- only its hash is ever stored, matching how no other
// secret in this codebase is ever persisted in reconstructible form.
function generateToken() {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token), tokenPrefix: token.slice(0, 16) };
}

function extractBearer(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Authenticates an external ingestion request. Returns the credential row
// (never the token) or throws a 401/403 HttpError, matching db.admin()'s
// existing shape for the human-session path this parallels.
async function authenticate(db, event, requiredPermission = 'SOURCE_INTELLIGENCE_IMPORT') {
  const token = extractBearer(event);
  if (!token) throw new HttpError(401, 'Missing Authorization bearer token.');
  const [credential] = await db.select('api_credentials', { token_hash: 'eq.' + hashToken(token), limit: 1 });
  if (!credential) throw new HttpError(401, 'Invalid credential.');
  if (credential.status !== 'active') throw new HttpError(403, 'This credential is ' + credential.status + '.');
  if (!credential.permissions.includes(requiredPermission)) throw new HttpError(403, 'This credential does not have the ' + requiredPermission + ' permission.');
  await db.patch('api_credentials', { id: 'eq.' + credential.id }, { last_used_at: new Date().toISOString() });
  return credential;
}

// Enforces the credential's per-minute rate limit and rolling 24-hour source
// quota from a single append-only request log, then records this request.
// Logged (and counted) even for a DRY_RUN, since a client hammering the
// endpoint with free analysis calls should still be throttled -- the log is
// the quota, not a side effect of a successful write.
async function checkAndLogRequest(db, credential, { mode, sourcesSubmitted = 0, batchId = null }) {
  const oneMinuteAgo = new Date(Date.now() - 60000).toISOString();
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
  const [recent, daily] = await Promise.all([
    db.select('api_credential_requests', { credential_id: 'eq.' + credential.id, requested_at: 'gt.' + oneMinuteAgo, select: 'id' }),
    db.select('api_credential_requests', { credential_id: 'eq.' + credential.id, requested_at: 'gt.' + oneDayAgo, select: 'sources_submitted' }),
  ]);
  if (recent.length >= credential.rate_limit_per_minute) throw new HttpError(429, 'Rate limit exceeded: ' + credential.rate_limit_per_minute + ' requests per minute.');
  const dailyTotal = daily.reduce((sum, r) => sum + (r.sources_submitted || 0), 0);
  if (dailyTotal + sourcesSubmitted > credential.daily_source_limit) throw new HttpError(429, 'Daily source limit exceeded: ' + credential.daily_source_limit + ' sources per rolling 24 hours.');
  await db.insert('api_credential_requests', { credential_id: credential.id, mode, sources_submitted: sourcesSubmitted, batch_id: batchId });
}

module.exports = { hashToken, generateToken, extractBearer, authenticate, checkAndLogRequest, TOKEN_PREFIX };
