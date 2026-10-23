"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { _test } = require("../netlify/functions/stripe-webhook");

test("plan detection uses the pre-discount, pre-tax subtotal", () => {
  assert.equal(_test.planForSession({ amount_subtotal: 14900, amount_total: 11920 }), "professional", "a 20% coupon still maps to Professional");
  assert.equal(_test.planForSession({ amount_subtotal: 24900, amount_total: 26643 }), "team", "sales tax still maps to Team");
  assert.equal(_test.planForSession({ amount_total: 14900 }), "professional", "older payloads without a subtotal still work");
  assert.equal(_test.planForSession({ amount_subtotal: 999, amount_total: 999 }), null);
});

test("signature verification accepts any matching v1 signature and rejects stale or forged ones", () => {
  const secret = "whsec_test", body = '{"type":"x"}', t = Math.floor(Date.now() / 1000);
  const sig = (sec, ts) => crypto.createHmac("sha256", sec).update(ts + "." + body, "utf8").digest("hex");
  assert.equal(_test.verifyStripeSignature(body, "t=" + t + ",v1=" + sig(secret, t), secret), true);
  assert.equal(_test.verifyStripeSignature(body, "t=" + t + ",v1=" + sig("old_secret", t) + ",v1=" + sig(secret, t), secret), true, "rotation sends two v1 values");
  assert.equal(_test.verifyStripeSignature(body, "t=" + t + ",v1=" + sig("wrong", t), secret), false);
  assert.equal(_test.verifyStripeSignature(body, "t=" + (t - 600) + ",v1=" + sig(secret, t - 600), secret), false, "older than five minutes");
  assert.equal(_test.verifyStripeSignature(body, "", secret), false);
});
