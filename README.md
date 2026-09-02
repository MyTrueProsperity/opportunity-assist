# Opportunity Assist — Landing Site

Public marketing landing page for **Opportunity Assist**, a My True Prosperity product.
*Opportunity Intelligence for Mission-Driven Growth — Stop chasing. Start choosing.*

Static site: plain HTML, CSS, and JS. No build step. Deploys to Netlify.

## Structure
```
opportunity-assist-site/
├── index.html          # Full landing page (SEO meta + JSON-LD baked in)
├── assets/
│   ├── styles.css      # Styles
│   └── app.js          # Mobile nav + footer year
├── netlify/functions/  # Scheduled Supabase availability checks
├── docs/               # One-time Supabase health-check setup SQL
├── robots.txt          # Crawl directives + sitemap reference
├── sitemap.xml         # Sitemap (update as pages are added)
├── netlify.toml        # Netlify config + security/cache headers
└── .gitignore
```

## What's included (SEO / GEO / AEO)
- Unique title + meta description, canonical URL, Open Graph + Twitter cards
- JSON-LD: Organization, SoftwareApplication, Product offers, FAQPage
- One H1, logical H2/H3, crawlable HTML text, descriptive alt/aria
- robots.txt + sitemap.xml, mobile-friendly, fast (no frameworks)

## Run locally
Just open `index.html` in a browser, or serve it:
```bash
python3 -m http.server 8080   # then visit http://localhost:8080
```

## Supabase health checks

The `supabase-healthcheck` Netlify Function runs at 02:00, 10:00, and 18:00 UTC
each day. It performs one read-only query against the `healthcheck` table in
Opportunity Assist and Classroom Credit Score.

Before the function can succeed:

1. Run `docs/supabase-healthcheck.sql` once in each Supabase project's SQL Editor.
2. Add these environment variables in the Netlify UI with Functions access:
   - `OPPORTUNITY_SUPABASE_PUBLISHABLE_KEY`
   - `CCS_SUPABASE_PUBLISHABLE_KEY`
3. Trigger a new production deploy after adding the variables.
4. Open the function in Netlify and select **Run now** to verify both queries.

Use each project's publishable key, or its legacy `anon` key. Never use a
`service_role` or Supabase secret key for this health check.

## Admin Access, Contract Watch, Alerts, AI Assistant

One SQL file, `docs/admin-and-features-setup.sql`, sets up all four of these
together since they share the same org-scoped RLS pattern. Run it once in
the Supabase SQL Editor.

**Admin access ("the backdoor").** Not a bypass-authentication backdoor —
that would be a real vulnerability now that this app holds paying customers'
data. Instead: an `admins` table, readable only by a user checking their own
row, writable by nobody except direct SQL. Once you (or anyone) is flagged,
the app shows an Admin nav item with every organization's subscription
status and Activate / Deactivate buttons, calling
`netlify/functions/admin-set-subscription.js`. That function re-checks the
`admins` table server-side before writing anything, so the authorization
isn't just a hidden nav link. To make yourself an admin, find your user id
under Supabase Auth → Users, then run the `insert into admins` statement at
the bottom of the SQL file. From there, comping your own org (or anyone
else's) is a button click, not a SQL script each time.

**Contract Watch.** A `contracts` table for renewal dates on agreements you
already hold, separate from discovering new opportunities. Dashboard shows a
count renewing in the next 60 days.

**Alerts.** Keyword or fit-score-threshold rules, matched client-side
against whatever's already loaded in the Funding Radar — no push
infrastructure, no separate notifications table. The Dashboard shows a
running match count. This is intentionally the light version: real-time
push alerts would need a different architecture (a queue, a way to reach
someone outside the app) and isn't built here.

**AI Assistant.** `netlify/functions/ai-assistant.js` is a context-aware
Q&A endpoint, not a full tool-calling agent — it injects a bounded slice of
the org's own data (profile, pipeline stage counts, top 8 scored
opportunities) into the prompt rather than giving the model live database
access. Gated behind the same active-subscription check as AI Fit Scoring,
enforced server-side. If it turns out people want the assistant to reach
further into their data, that's a real architecture change (tool use, most
likely), not a small addition.

## AI Fit Scoring

The `score-opportunities` Netlify Function generates each opportunity's Fit
Score and AI Opportunity Summary on demand, the moment a signed-in user's
Funding Radar has an opportunity it hasn't scored yet for their organization.
Uses Claude Haiku, scoped to the caller's own organization by their Supabase
session token, and stays dependency-free (no `@supabase/supabase-js`, just
`fetch` against the Supabase REST API).

Env vars, set in the Netlify UI with Functions access:
- `ANTHROPIC_API_KEY` — already set
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` — same values as `OA_CONFIG` in `app.html`
- `SUPABASE_SERVICE_ROLE_KEY` — optional but recommended. Without it, Fit
  Scores still generate normally, but the AI Opportunity Summary isn't cached
  globally (every organization that views the same opportunity regenerates
  its own copy) and nothing is logged to `ai_usage_logs`. Add it from the
  Supabase project's Project Settings → API, then run
  `docs/ai-usage-logs-setup.sql` once in the SQL Editor.

Never put the `service_role` key in `app.html` or any other client-facing file.

## Early Access Capture

The landing page's "Request early access" button used to be a plain `mailto:`
link. It now submits to `request-early-access`, which saves each submission
to Supabase instead of relying on catching every email. A honeypot field
filters out most bots without adding a CAPTCHA. No email notification is
wired up yet — check new rows in Supabase's Table Editor, or run:

```sql
select * from early_access_requests order by created_at desc;
```

Setup:

1. **Run `docs/early-access-setup.sql`** once in the Supabase SQL Editor.
2. **Env vars**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — both already
   needed for billing and the crawler above, nothing new to add here.

Worth adding later if volume picks up: a Resend or similar integration so a
new request emails Bill directly instead of requiring a manual check.

## Opportunity Crawler

The `sam-gov-crawler-background` function runs daily at 09:00 UTC (see
`netlify.toml`) and populates the shared `opportunities` table from the
SAM.gov Opportunities API — this is what the Funding Radar actually has to
show once it's live. It's a Background Function (note the `-background`
filename), since six sequential SAM.gov calls plus Supabase writes can run
past the 10-second limit on a regular function.

Setup:

1. **Get a free SAM.gov API key** at
   [sam.gov/data-services](https://sam.gov/data-services) (requires a SAM.gov
   account, no cost). This is separate from an entity/UEI registration.
2. **Run `docs/sam-gov-crawler-setup.sql`** once in the Supabase SQL Editor.
   Adds the `external_id` column and a unique index so re-crawls update
   existing rows instead of duplicating them.
3. **Set env vars**: `SAM_GOV_API_KEY`, plus the `SUPABASE_SERVICE_ROLE_KEY`
   already needed for billing (see "Paywall / Billing" above).
4. **Trigger a new deploy**, then open the function in Netlify and select
   **Run now** to verify it populates opportunities. Function logs report
   how many were fetched, upserted, and (if any) failed.

**NAICS codes.** The crawl is scoped to `NAICS_CODES` at the top of the
function — a starter list matching workforce development, financial
capability, youth employment, and community-prosperity work. This is the
single biggest lever on how relevant the Funding Radar feels; review and
adjust it before relying on this for real.

**What's not pulled in.** Each notice's full description text lives behind a
second, separate authenticated SAM.gov call per notice. To keep the crawl
fast and cheap, this function stores title, agency, type, NAICS, place of
performance, deadline, set-aside, and a direct link to the full posting on
SAM.gov — enough for AI Fit Scoring to work with. Pulling in full description
text is a reasonable Phase 2 addition if it turns out to matter.

## Opportunity Sourcing: Grants.gov

SAM.gov is almost entirely contract and procurement solicitations, not grants — a real limitation for a nonprofit-heavy audience. `grants-gov-crawler-background` fills that gap, using Grants.gov's public `search2` API. No API key needed, unlike SAM.gov, so this one has zero setup blocker beyond running the SQL below.

Deliberately does not filter by Grants.gov's eligibility or funding-category codes: the sourcing on those exact values was inconsistent enough that guessing wrong risked silently filtering out every nonprofit-eligible grant. Searches by keyword only instead, and leans on the AI Fit Scoring every org already gets to sort eligibility fit per organization. Same reasoning as SAM.gov applies to skipping the full-text `fetchOpportunity` call per notice: keeps the crawl fast, title + agency + dates + a direct link is enough for AI Fit Scoring to work with.

No new SQL migration needed — this reuses the `external_id` column and unique index already added by `docs/sam-gov-crawler-setup.sql`. Reuses the same `SUPABASE_SERVICE_ROLE_KEY` env var as the SAM.gov crawler; nothing new to add there either.

**Keywords.** The crawl is scoped to `KEYWORDS` at the top of the function — a starter list matching workforce development, financial capability, youth employment, and community-prosperity work. Same role as SAM.gov's NAICS list: the single biggest lever on relevance, edit freely.

Runs daily at 09:10 UTC (see `netlify.toml`), ten minutes after the SAM.gov crawler, so the two don't hit Supabase at the same moment.

## Weekly Foundation Scan

SAM.gov and Grants.gov are both structured government APIs -- reliable, but they cover federal funding only. Individual foundations, community foundations, and bank charitable trusts have no API at all, just a webpage, and most explicitly aren't always-open the way a government posting is (invitation-only, relationship-driven, LOI-gated). `foundation-scan-background` covers this different kind of source with a fundamentally different approach: instead of a structured API response, Claude reads each funder's page directly and reports back what's actually there.

That's exactly why results land in their own table, `foundation_scan_hits`, never mixed into `opportunities`. Rows in `opportunities` are structured government data and treated as authoritative. Rows here are Claude's best read of a webpage at scan time -- genuinely useful, but a different kind of claim, and the app should label them accordingly wherever they're shown rather than presenting both with the same confidence.

The system prompt is explicit that nothing gets invented: a deadline or amount not actually written on the page comes back null, never a guess. A fabricated number is a worse failure than a missing one -- a practitioner acting on a deadline that was never real is a real harm, an empty field is just a reason to click through and check the source.

**Watchlist.** `FUNDER_WATCHLIST` at the top of the function is a starting set of 20 funders -- Florida and Central Florida funders first, then national financial-capability and workforce funders -- pulled from a much larger source list. Same role as the NAICS/keyword lists in the other two crawlers: the biggest lever on relevance, and meant to be edited, not treated as final.

Runs weekly, Monday 10:00 UTC (see `netlify.toml`), separate from the two daily crawlers -- each item here is a full fetch-plus-Claude-read, a heavier operation than a single structured API request, so it doesn't need or want a daily cadence.

Setup: run `docs/foundation-scan-setup.sql` once in the Supabase SQL Editor. No new env vars -- reuses `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `ANTHROPIC_API_KEY`, all already set for the other functions.

## Paywall / Billing

AI Fit Scoring is gated behind an active subscription. Account creation,
browsing, the Kanban capture pipeline, and the free heuristic estimate all
stay open to everyone, including anonymous "Explore as guest" sessions —
guests and unsubscribed orgs simply never trigger a real (paid) AI call; they
see the free estimate labeled accordingly. The `score-opportunities` function
enforces this server-side regardless of what the client sends, so it can't be
bypassed by editing `app.html`.

Setup, from scratch:

1. **Run `docs/stripe-billing-setup.sql`** once in the Supabase SQL Editor.
   Creates the `subscriptions` table, locked down so only the service role
   key can write it.
2. **Create two Stripe Payment Links** — Professional at $149/mo and Team at
   $249/mo, matching the prices already published on the landing page.
   Enterprise stays a "Contact us" mailto link, same as `index.html`.
3. **Paste the two links into `app.html`**, replacing the placeholders in
   `PLAN_LINKS` near the top of the inline script. No other client code
   needs to change.
4. **Add a webhook endpoint in Stripe** (Developers → Webhooks → Add
   endpoint): `https://opportunityassist.com/.netlify/functions/stripe-webhook`,
   listening for `checkout.session.completed`, `customer.subscription.updated`,
   and `customer.subscription.deleted`. Copy the signing secret it gives you.
5. **Set env vars** in the Netlify UI with Functions access:
   - `STRIPE_WEBHOOK_SECRET` — from step 4
   - `SUPABASE_SERVICE_ROLE_KEY` — required for this function to write
     subscriptions at all. As a bonus, this also switches on the AI Opportunity
     Summary global cache and `ai_usage_logs` mentioned in "AI Fit Scoring"
     above, since both were only optional for lack of this same key.
6. **Trigger a new deploy**, then run a real $1-scale test purchase to confirm
   the webhook fires and the org's Organization page flips to "Active."

Plan detection matches on the exact amount charged rather than a Stripe price
ID, since Payment Links keep this dependency-free. If prices ever change,
update `AMOUNT_TO_PLAN` in `stripe-webhook.js` and `PLAN_LINKS` in `app.html`
together.

To comp an organization without Stripe (e.g. MTP's own account), see the
commented `insert` at the bottom of `docs/stripe-billing-setup.sql`.

## Deploy: GitHub → Netlify (recommended)
1. Create an empty GitHub repo named `opportunity-assist`.
2. From this folder, push the existing local repo (already initialized):
   ```bash
   git remote add origin https://github.com/<your-account>/opportunity-assist.git
   git branch -M main
   git push -u origin main
   ```
3. In Netlify: **Add new site → Import an existing project → GitHub →** select `opportunity-assist`.
   - Build command: *(leave blank)*
   - Publish directory: `.`
4. Every `git push` to `main` now auto-deploys.

## Custom domain
In Netlify → Domain settings, add `opportunityassist.com` once the domain is ready.
Update the URLs in `index.html` (og/canonical), `robots.txt`, and `sitemap.xml` if the final domain differs.
