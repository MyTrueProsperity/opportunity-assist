const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/password-reset.js'), 'utf8');

function harness(hash = '#access_token=test-token&type=recovery') {
  const elements = Object.fromEntries(
    ['resetStatus', 'resetForm', 'resetButton', 'newPassword', 'confirmPassword'].map(id =>
      [id, { hidden: id === 'resetForm', disabled: false, className: '', textContent: '', value: '', addEventListener(type, handler) { this[type] = handler; } }]
    )
  );
  let authChanged;
  let updates = [];
  let urlCleared = false;
  const auth = {
    onAuthStateChange(handler) { authChanged = handler; },
    getSession() { return Promise.resolve({ data: { session: null }, error: null }); },
    updateUser(value) { updates.push(value); return Promise.resolve({ error: null }); }
  };
  let clientOptions;
  const context = {
    URLSearchParams,
    document: { getElementById(id) { return elements[id]; } },
    window: {
      location: { hash, search: '', pathname: '/reset-password.html' },
      history: { replaceState(_state, _title, path) { assert.equal(path, '/reset-password.html'); urlCleared = true; } },
      OA_CONFIG: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public' },
      supabase: { createClient(_url, _key, options) { clientOptions = options; return { auth }; } }
    }
  };
  vm.runInNewContext(source, context);
  return { elements, auth, updates, get authChanged() { return authChanged; }, get urlCleared() { return urlCleared; }, get clientOptions() { return clientOptions; } };
}

test('direct visit or expired link cannot open password form', async () => {
  const direct = harness('');
  assert.equal(direct.elements.resetForm.hidden, true);
  assert.match(direct.elements.resetStatus.textContent, /invalid or has expired/);
  const expired = harness('#error=access_denied&error_code=otp_expired');
  assert.equal(expired.elements.resetForm.hidden, true);
  assert.equal(expired.urlCleared, true);
});

test('only a recovery event permits password update', async () => {
  const h = harness();
  assert.equal(h.clientOptions.auth.persistSession, false);
  h.authChanged('SIGNED_IN', { user: { id: 'normal-user' } });
  assert.equal(h.elements.resetForm.hidden, true);
  h.authChanged('PASSWORD_RECOVERY', { user: { id: 'recovery-user' } });
  assert.equal(h.elements.resetForm.hidden, false);
  assert.equal(h.urlCleared, true);
  h.elements.newPassword.value = 'long-new-password';
  h.elements.confirmPassword.value = 'different-password';
  h.elements.resetForm.submit({ preventDefault() {} });
  assert.equal(h.updates.length, 0);
  assert.match(h.elements.resetStatus.textContent, /do not match/);
  h.elements.confirmPassword.value = 'long-new-password';
  h.elements.resetForm.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].password, 'long-new-password');
  assert.equal(h.elements.resetForm.hidden, true);
  assert.match(h.elements.resetStatus.textContent, /updated/);
});

test('failed update leaves form available for retry', async () => {
  const h = harness();
  h.auth.updateUser = () => Promise.resolve({ error: { message: 'Password policy rejected it' } });
  h.authChanged('PASSWORD_RECOVERY', { user: { id: 'recovery-user' } });
  h.elements.newPassword.value = 'long-new-password';
  h.elements.confirmPassword.value = 'long-new-password';
  h.elements.resetForm.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(h.elements.resetForm.hidden, false);
  assert.equal(h.elements.resetButton.disabled, false);
  assert.match(h.elements.resetStatus.textContent, /Password policy rejected it/);
});
