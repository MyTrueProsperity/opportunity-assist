# Opportunity Assist zero-token harvester

Implemented inside Source Intelligence. Routine worker entry points no longer construct the paid provider. Existing Grant Factory drafting, analysis, scoring and other deliberately requested AI features retain their behavior. This change does not promise zero AI cost for those separate features.

## Architecture and database audit

Repository: `MyTrueProsperity/opportunity-assist`, local checkout `C:\Users\Mills\Documents\Codex\LocalCodingBot\opportunity-assist`. Netlify static app with Node server functions and Supabase REST/RPC. Live project `girldctsnrdvdoktzfrv` was inspected read-only on October 5, 2026. Live Source Intelligence columns and URL/domain/identity/due indexes match the repository migrations. Its opportunity fields use `summary`, `funding_amount`, `requirements`, and `category`, rather than every example field in the request. Findings therefore enter its canonical candidate layer before the existing publication transaction maps them to opportunities.

Reuse: funding_programs, source_candidates, source_candidate_sightings, source_page_cache, source_scan_history, source_jobs, source_discovery_runs, source_engine_settings, source_state_settings, source_ingest_candidate, existing review and publication RPCs. No migrations or new registries. RLS, authentication and service credentials are unchanged. Service credentials stay in existing server-only configuration, consistent with [Supabase's RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

Live engine and Florida discovery/monitoring were enabled at inspection, with automatic approval enabled and a 200-page daily ceiling. Those settings were not changed. The deployed old code can continue incurring costs until this change is deployed. Do not claim that this local implementation has already stopped auto-recharge.

## Components and changes

- `netlify/lib/source-intelligence/harvester.js`: collection, parsing, classification, scoped comparisons, review staging, material-change records and zero-cost metrics.
- `data/harvester-themes.json`: configurable classification vocabulary.
- `netlify/lib/source-intelligence/fetch-page.js`: retains structured/raw response data, detects metadata/link changes, supports JSON/XML and per-host 1.5-second pacing; retains bounded HTTP requests, DNS pinning, private-address rejection, robots checks, redirects and conditional requests.
- `netlify/lib/source-intelligence/worker.js`: defaults to deterministic collection; existing jobs, state gates and page ceilings remain authoritative. Paid providers can only be explicitly injected by developer/test code, never by request fields or scheduled handlers. Historical query-based discovery pauses with an actionable reason when no directory/feed URLs are supplied.
- `netlify/lib/source-intelligence/service.js`: harvested candidates require human review even if the global automatic-approval policy is enabled.
- `netlify/functions/source-intelligence-admin.js`: existing authenticated endpoint accepts `harvest_preview` and `harvest_queue`, 1–25 sources per pilot request.
- `netlify/functions/foundation-scan-background.js`: removes automatic daily whole-corpus reconciliation. Explicit administrator reconciliation remains available.
- `scripts/harvest-grants.js`: local fixture/live collector and exact pipe/JSON import output; never opens a database connection.
- `tests/harvester.test.js` and `tests/fixtures/harvester/*`: deterministic and PostgreSQL integration coverage and a synthetic pilot corpus.

## Polling, parsing, deduplication and review

Intake capacity was increased at the user's request: deterministic collection drains up to 20 jobs per invocation instead of stopping after one. Due scheduling can admit up to ten monitors and ten re-verifications per state. Paid-provider test/developer paths keep their prior one-collection-job stop. This changes throughput without bypassing review or adding a queue-size pause. The existing five-minute worker trigger dispatches due jobs; it does not fetch every source every five minutes. It selects at most ten active due programs per enabled state per invocation and processes up to twenty jobs. Government sources default to daily, foundations every three days, others weekly. `poll_days` accepts 1–30 when provided to the collector. Existing failure backoff rises to 14 days. Inactive sources are excluded from recurring monitoring. Bounded link discovery follows at most three links per page, to depth two; explicit JSON next links, RSS/Atom entries and sitemaps are supported. Existing page ceilings and job dedupe keys bound the work further.

Parsing order: JSON API records, XML RSS/Atom/sitemap, HTML JSON-LD, article/table-row/list blocks, then one explicit H1 page. Generic text or PDF prose that cannot identify programs reliably needs review. No model fallback exists. Unknown geography, amounts, dates and eligibility stay unknown. Dates require an explicit ISO year/date. Amounts currently require structured numeric fields. Only explicit eligibility geography establishes state applicability; the pilot's target state does not establish eligibility.

Canonical URLs retain meaningful parameters and drop tracking/fragments. Explicit provider IDs take precedence for candidate identity; otherwise the established source/program identity rules apply. Registry comparisons use the existing domain index and a 500-row bound; reaching that bound fails safely for review. Candidate lookups use the unique identity index. Multiple programs on the same page are not collapsed merely because their URLs match. Conflicting identities are proposed for review, never destructively merged. Local exports also deduplicate across sources.

Changed proposals keep their candidate identity and append sightings and scan snapshots. Material deadline, award, eligibility, geography, application URL, open/closed and funder differences appear in `material_changes`. Existing verified programs and opportunity/Grant Factory records are never overwritten by a scrape. Finalized review decisions remain untouched. Only pending/investigating/matched proposals can be refreshed by the existing transactional RPC. Source health is updated without assigning a new verification timestamp to the canonical program.

Expired, incompatible explicit geography/applicant types, invitation-only, missing deadline, ambiguous eligibility/geography, contradictory deadlines, PDF requirements and conflicts have review reasons. Existing PENDING/HUMAN_REVIEW statuses carry them; no separate AI workflow or automatic Claude call is created. Evidence-complete candidates can use the existing human review action; incomplete candidates remain investigatable. Human approval/publication remains subject to the existing database guards.

## Cost and write behavior

Routine paid LLM calls = 0; paid tokens = 0; estimated AI cost = $0.00. Local mode has no database requests. Server mode checks one cached URL, performs one bounded registry lookup per changed source and one batched identity lookup for all extracted records. Changed candidates use one transactional RPC each, not per-field requests. Cache/history are written once per changed page; canonical health is updated once for a monitored program. An unchanged monitor makes one scheduling/health patch; unchanged candidates, opportunities and caches are not rewritten. Worker job leasing, state checks, budget accounting and run metrics add their existing control-plane operations; the collector's read/write counts exclude those. Explicit legacy import/reconciliation operations still use the old import implementation; they are not routine collection and should not be repeatedly invoked during development.

## Local commands

From the repository directory:

```powershell
node scripts/harvest-grants.js tests/fixtures/harvester/registry.json work/harvest-pilot
node scripts/harvest-grants.js tests/fixtures/harvester/registry.json work/harvest-pilot
node scripts/harvest-grants.js your-registry.json work/live-pilot --live
node --test --test-concurrency=2 tests/*.test.js
node scripts/build.js
node scripts/check-functions.mjs
```

Registry JSON is either an array or `{ "sources": [...] }` using the established source fields. Fixture entries add a `fixture` path relative to the registry file. A maximum of 25 input sources is intentional for pilots. Local execution writes `sources.txt`, `sources.json`, `opportunities-review.json`, `report.json` and a local cache. Synthetic fixture funders and example.org URLs are test data, never discoveries or production sources. Changing fixture data causes a fresh extraction; repeated identical pages are skipped.

## Production activation process

1. Review the diff and deploy through the repository's existing GitHub/Netlify workflow. No production import, deployment, migration or setting change was performed by this implementation task.
2. Leave `HARVESTER_PRODUCTION_ENABLED` unset/false while reviewing a pilot. Default scheduled/manual worker handlers return paused with zero AI calls. Engine/state switches remain additional guards.
3. Use the existing authenticated administrator endpoint `POST /.netlify/functions/source-intelligence-admin` with an administrator bearer session and `{ "action":"harvest_preview", "state":"FL", "sources":[...] }`. This returns live dry-run findings and per-source operation counts without writes. Inspect all collisions and ambiguous findings. Start with 1–25 reviewed registry URLs. Preview itself does not enqueue child pages.
4. Use the same endpoint with `action:"harvest_queue"` for the reviewed sources. It creates the established VALIDATE jobs with QUEUE behavior. Existing `source-intelligence-import` also continues accepting the established source batch format in DRY_RUN followed by QUEUE. Do not use TRUSTED_AUTOMATION to bypass review.
5. Enable the existing engine and Florida monitoring controls as appropriate, retaining the validated-state restrictions. Set Functions-scoped `HARVESTER_PRODUCTION_ENABLED=true` and redeploy. The existing scheduled handler runs every five minutes, collecting up to twenty jobs per invocation within the existing time and page budgets; source polling follows due timestamps. Disable the variable or pause the engine to stop.
6. Before the first activation, inspect queued jobs and enabled states in the existing admin interface to determine the actual current source count; queued work predates this change. Do not interpret the local one-source pilot as authorization to process the whole backlog. Account for up to three links per changed page and depth two, bounded by daily page ceilings. Collect source/run metrics and review findings before increasing coverage.

## Validation and limits

Synthetic corpus covers federal, Florida/local government, community/corporate/bank foundations, workforce, HTML, RSS, JSON, pagination, PDF links and an empty page. Integration tests cover changed deadlines, duplicate identity, manual decision preservation and repeated unchanged pages. Additional tests cover failures, contradictory deadlines, external IDs, conditional requests, pacing, dates and default worker behavior. Existing suites cover source transactions, authorization, private-network blocking, imports, pagination and packaging. Final full suite: 529 tests, 528 passed, 0 failed, 1 existing skip. All 13 harvester tests passed. Static build, diff whitespace checks, and all 18 function bundles passed. No separate lint script is configured; syntax checks and the repository's tests/build/function packaging are used. The Linux-only archived PDF smoke check does not run on this Windows host.

Fixture first run: 13 checked/changed, 4 proposed findings, 8 duplicates prevented, 3 needing interpretation, 0 errors, 0 DB reads/writes, 0 paid calls/tokens. Repeat: 13 unchanged, 0 findings, 0 DB writes, 0 paid calls/tokens. These are synthetic results, not grant research.

One real source dry-run, from the live registry: Florida DEP additional funding resources, 1 checked/changed, 6 provisional findings, all 6 needing interpretation, 0 errors and 0 database writes/AI calls/tokens. These include grant-page links and are not six vetted active opportunities. No follow-up broad crawl or production insertion occurred. The initial sandbox network attempt was blocked; one permitted live retry succeeded.

Unsupported: arbitrary POST-only APIs, website-specific field mappings/selectors, browser-rendered or bot-protected sites, prose-heavy eligibility and awards, scanned PDF/OCR, complicated fiscal-sponsor rules, infinite or implicit pagination, and broad web search without explicit starting URLs. Difficult PDFs and extraction failures stay visible for manual review. No claims of comprehensive nationwide coverage are made. Existing Grants.gov and SAM.gov collectors remain separate pre-existing zero-LLM endpoints; they were not rewritten in this task.

## Example source output (existing live registry record)

```text
Coastal Partnership Initiative Grants|https://floridadep.gov/lands/land-and-recreation-grants/content/additional-funding-resources|GOVERNMENT_GRANT|Florida coastal counties and municipalities|coastal management, public access
```

```json
{
  "batch_name": "AUTO_GRANT_HARVEST_2026-10-05",
  "submitted_by": "opportunity-assist-harvester",
  "mode": "DRY_RUN",
  "sources": [{
    "source_name": "Coastal Partnership Initiative Grants",
    "url": "https://floridadep.gov/lands/land-and-recreation-grants/content/additional-funding-resources",
    "source_type": "GOVERNMENT_GRANT",
    "geography": "Florida coastal counties and municipalities",
    "keywords": ["coastal management", "public access"]
  }]
}
```

All existing Opportunity Assist and Grant Factory production records were preserved: production access for this task was read-only. No secrets were added, no production scans were repeated for debugging, and no recurring production harvesting was activated.
