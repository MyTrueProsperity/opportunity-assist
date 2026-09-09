# Architecture audit — 8 September 2026

Audited repository commit `574509429da281dbec45b655699548606b055b48`, all 24 tracked files, the live Netlify dashboard, and read-only catalog/data queries in Supabase project `girldctsnrdvdoktzfrv`. No credentials were retrieved or changed.

## Existing runtime

Plain HTML/CSS/JavaScript with a Supabase browser client in `app.html`; dependency-free Node Netlify functions using REST. Netlify production deploy `6a9acc2a7b07680008e3ea89` is published from the audited commit. Nine functions are deployed. SAM.gov runs 09:00 UTC daily, Grants.gov 09:10, Foundation Scan 10:00; health checks 02:00/10:00/18:00. The dashboard's live log panel did not return historical scan logs, so successful recent invocations cannot be inferred from schedule configuration alone.

Environment names observed (values deliberately not revealed): ANTHROPIC_API_KEY, CCS_SUPABASE_PUBLISHABLE_KEY, OPPORTUNITY_SUPABASE_PUBLISHABLE_KEY, SAM_GOV_API_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL. Provider/service credentials have Functions scope. No independent search-provider key is configured.

SAM.gov searches six NAICS codes plus organization keywords (40-keyword cap). Grants.gov searches baseline and organization keywords (200 cap). Both upsert shared `opportunities` by provider external ID. Neither is a canonical funder registry. Scoring is subscription gated, authenticated, and scoped by `(org_id, opportunity_id)`. Existing billing, assistant and subscription administration remain integration boundaries.

## Actual database and source inventory

At audit time: 740 opportunities: Foundation Scan 543, Grants.gov 149, SAM.gov 45, and one each Foundation, City Procurement, State of Florida. There are 108 legacy `foundation_scan_hits`, one administrator, and no source intelligence registry. All 14 original public tables have RLS enabled. Relevant additional tables: organizations, profiles, subscriptions, fit_scores, pipeline_items, ai_usage_logs, contracts, alert_rules, knowledge_assets, early_access_requests, healthcheck.

The current function contains 3,391 watchlist rows, 3,317 exact distinct URLs, 74 repeated URLs, and 2,349 domains. Each row retains only `name` and `url`; source type, geography and keywords are not present and must stay null unless supported by evidence. The list includes national and other-state sources, aggregators, directories, scholarships, generic homepages and named programs. A lead must not become an asserted funding mechanism merely because it is in this curated list. Every original row must be preserved, including multiple names sharing one URL.

A concurrently running chat created `funder_watchlist` during this audit: bigint id, name, url, created_at; 500 rows at observation, service-role-only RLS. The owner confirmed concurrent work. Its completed schema and scanner revision must be reconciled before integration. This branch must import that table if present, retain it, and avoid overwriting concurrent production edits.

Live opportunities have deadline_mentioned/amount_mentioned and verification booleans. Their external ID index is a full unique index, unlike the old partial-index setup SQL. Legacy hits have relevance_note and verification booleans missing from their setup SQL. The actual contracts and alerts columns differ from the existing client/setup files; this pre-existing drift is documented rather than silently rebuilding those unrelated features.

RLS: shared opportunities require authentication; legacy hits allow public SELECT; fit_scores/pipeline/contracts/alerts/knowledge use current_org_id(). Admins can only inspect their own admin row, and admins additionally read organizations/subscriptions. Source writes are service-role-only. The two existing public functions are current_org_id() and handle_new_user(), both SECURITY DEFINER with fixed public search paths. AI usage currently requires a non-null customer org_id, so global discovery usage belongs in its own run accounting, not a fabricated customer organization.

## Confirmed discrepancies and gaps

* README says 20 sources, weekly scanning, separate hits table. Production code contains 3,391 sources and scans a weekday shard daily into shared opportunities. A fixed weekday shard still revisits an individual source weekly; the comment promising next-day detection is inaccurate.
* The client still loads and renders the legacy table. New results reach Radar and per-org scoring, while Foundation Leads shows the old 108 records.
* Foundation Scan only normalizes scheme/trailing slash and lowercases the whole URL, including case-sensitive paths. It has no aliases, program identity, semantic evidence, quarantine, content cache, source health ledger or run cost accounting.
* A single source-page external ID cannot represent multiple programs/cycles. A successful model answer saying nothing open causes physical opportunity deletion, potentially affecting references. Fetch failures do not delete, but negative extraction is not sufficiently strong closure evidence.
* The watchlist is not Florida-only and contains leads requiring validation. Publication must not inherit a blanket endorsement from this list.

## Implementation decision

Keep Supabase canonical; keep Netlify runtime and existing app. Add normalized funders/programs, immutable raw-import provenance, aliases, quarantined candidates, review decisions, cycle links, scan history, durable jobs, budgeted runs, geographic entities and a county/category coverage matrix. Import all copies idempotently. Preserve uncertain parent/program facts as unknown. Deterministic identity and lexical evidence run first; semantic comparison is advisory and never an automatic rejection.

Reuse the existing Anthropic provider for bounded web-search discovery and evidence-based extraction, avoiding a new required key. Hash unchanged pages before extraction. Independently generate clean-room queries from geographic/category configuration; use registry data only during comparison. Track unsuccessful and partial sweeps honestly, with manual false-positive and false-negative assessments before national rollout.

Add per-state discovery, monitoring and publication switches, budgets and category selection. Florida is a pilot configuration. All other states remain disabled until a reviewed Florida validation report and explicit individual state activation. Durable jobs re-check state switches during execution. National applicability is evidence, not proof from a company's presence in a state.

## Risks and controls

Use additive, idempotent migrations and transactions for review/merge, locking candidates and identity keys. No production deletes. Preserve existing opportunity IDs and history, close cycles softly, invalidate cached fit/summary only for material opportunity changes. Enforce authorization server-side and restrict new tables/RPCs by RLS/privileges. Block private-network fetches and revalidate redirects; bound sizes/timeouts, honor robots and retry intervals, and quarantine unsupported/bot-blocked content without bypassing controls. Bound job duration, concurrency and daily provider reservations. Reconcile the concurrent branch before deployment, then verify migrations, RLS, workflow, deployment and a real bounded Florida pilot.
