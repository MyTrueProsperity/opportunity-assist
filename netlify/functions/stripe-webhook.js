// netlify/functions/stripe-webhook.js
//
// Activates and deactivates Opportunity Assist subscriptions based on Stripe
// events, by writing to the `subscriptions` table (service role only — the
// client can read it but never write it, see docs/stripe-billing-setup.sql).
//
// Verifies the Stripe signature manually with Node's built-in crypto module,
// no `stripe` npm package, keeping this repo dependency-free like the rest
// of netlify/functions.
//
// Setup: see readme.md "Paywall / Billing" for the full walkthrough — creating
// the two Payment Links, adding this endpoint in Stripe, and the env vars below.
//
// Env vars required:
//   STRIPE_WEBHOOK_SECRET       from Stripe Dashboard -> Developers -> Webhooks
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   required — this function writes subscriptions,
//                                which the client can only ever read.

const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Matched on the exact amount charged (cents), since this repo uses plain
// Stripe Payment Links rather than a price-ID lookup. Keep these in sync with
// PLAN_LINKS in app.html and the actual prices set on the two Payment Links.
const AMOUNT_TO_PLAN = { 14900: "professional", 24900: "team" };

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  if (!SUPABASE_URL || !SERVICE_KEY || !WEBHOOK_SECRET) {
    console.error("stripe-webhook misconfigured: missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or STRIPE_WEBHOOK_SECRET.");
    return { statusCode: 500, body: "Server misconfigured." };
  }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  const sigHeader = event.headers["stripe-signature"] || event.headers["Stripe-Signature"];
  if (!verifyStripeSignature(rawBody, sigHeader, WEBHOOK_SECRET)) {
    return { statusCode: 400, body: "Invalid signature." };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: "Invalid JSON." };
  }

  try {
    switch (stripeEvent.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(stripeEvent.data.object);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(stripeEvent.data.object);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(stripeEvent.data.object);
        break;
      default:
        break; // ignore everything else
    }
    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("stripe-webhook handler error:", err);
    // 500 so Stripe retries with its own backoff rather than treating this as delivered.
    return { statusCode: 500, body: "Handler error, see function logs." };
  }
};

async function handleCheckoutCompleted(session) {
  const orgId = session.client_reference_id;
  if (!orgId) {
    console.error("checkout.session.completed with no client_reference_id — can't link this payment to an organization.");
    return;
  }
  const plan = AMOUNT_TO_PLAN[session.amount_total] || null;
  await sbUpsert(
    "subscriptions",
    [{
      org_id: orgId,
      status: "active",
      plan,
      stripe_customer_id: session.customer || null,
      stripe_subscription_id: session.subscription || null,
      updated_at: new Date().toISOString(),
    }],
    "org_id"
  );
}

async function handleSubscriptionUpdated(sub) {
  const status = mapStripeStatus(sub.status);
  const amount = sub.items && sub.items.data && sub.items.data[0] ? sub.items.data[0].price.unit_amount : null;
  const plan = amount != null ? AMOUNT_TO_PLAN[amount] : undefined; // undefined = leave existing plan alone
  await patchByCustomer(sub.customer, { status, plan, stripe_subscription_id: sub.id, updated_at: new Date().toISOString() });
}

async function handleSubscriptionDeleted(sub) {
  await patchByCustomer(sub.customer, { status: "canceled", updated_at: new Date().toISOString() });
}

function mapStripeStatus(s) {
  if (s === "active" || s === "trialing") return "active";
  if (s === "past_due" || s === "unpaid") return "past_due";
  return "canceled";
}

/* ---------- Supabase REST helpers (service role — bypasses RLS by design) ---------- */

function sbHeaders() {
  return { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" };
}
async function sbUpsert(table, rows, onConflict) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?on_conflict=" + onConflict, {
    method: "POST",
    headers: Object.assign({}, sbHeaders(), { Prefer: "resolution=merge-duplicates" }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(table + " upsert failed: " + (await r.text()));
}
async function patchByCustomer(stripeCustomerId, patch) {
  if (!stripeCustomerId) {
    console.error("Subscription event with no customer id — skipping.");
    return;
  }
  const clean = {};
  Object.keys(patch).forEach((k) => { if (patch[k] !== undefined) clean[k] = patch[k]; });
  const r = await fetch(SUPABASE_URL + "/rest/v1/subscriptions?stripe_customer_id=eq." + encodeURIComponent(stripeCustomerId), {
    method: "PATCH",
    headers: sbHeaders(),
    body: JSON.stringify(clean),
  });
  if (!r.ok) throw new Error("subscriptions patch by customer failed: " + (await r.text()));
}

/* ---------- Stripe signature verification (manual — no stripe npm package) ---------- */

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => p.split("=")));
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  // Reject anything older than 5 minutes to guard against replay.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 300) return false;

  const signedPayload = timestamp + "." + rawBody;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1, "hex"));
  } catch (e) {
    return false; // length mismatch, malformed header, etc.
  }
}
