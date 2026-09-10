# Source Intelligence operations

Source Intelligence is part of the existing Opportunity Assist app and Netlify project. Supabase is the canonical store. The architecture audit records the production discrepancies that informed the implementation.

## Install and verify

1. Apply the eight SQL files in `supabase/migrations` in filename order to Opportunity Assist. Each is transactional and repeatable. They add source tables and opportunity links; they do not remove existing rows or alter customer access policies.
2. Deploy this branch through the existing GitHub → Netlify integration. Netlify uses Node 22, the pinned pnpm lockfile, `node scripts/build.js`, and `dist`. Only allowlisted public assets are published.
3. Existing Functions-scoped `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `ANTHROPIC_API_KEY` are required. No new credential is needed. Anthropic web search must be available on the existing account. Credentials never belong in browser assets.
4. Sign in with an existing administrator account and open **Source Intelligence → State controls**. Enable the engine, then select **Import / reconcile corpus** and **Process queued work now**. Check Discovery runs with **All states / unresolved** selected. Continue processing until reconciliation completes. Scheduled processing also runs every five minutes.
5. Verify import totals by origin against the live tables. The preserved GitHub snapshot contains 3,391 rows. The concurrently maintained `funder_watchlist` remains an import input; every row is retained in `source_import_rows`. Reconcile again after the other task finishes loading all lists.

Run `pnpm test`, `pnpm build`, and `pnpm check:functions` before deploying. The last command uses Netlify's own function packager. Test data lives only in an isolated PostgreSQL test database; `scripts/local-ui-server.js` provides a synthetic local interface on port 8791.

## Florida first, then one state at a time

All 50 states and DC start with discovery, monitoring, and publication disabled. The master engine also starts paused. There is no global switch that starts nationwide crawling.

For Florida, enable **Discovery** to run geographic searches, **Monitoring** to check known programs, and **Publication** only when approved, evidenced open opportunities should enter Radar. These switches are independent. To pause all work, pause the engine. To pause one capability in one state, change that state's setting; queued jobs recheck the setting before fetching.

The Coverage view includes all 67 Florida counties plus statewide searches, across 18 source categories. Select a cell or **Run independent FL pilot**. Queries derive from geography/category configuration and do not include the curated watchlist. The registry is used afterward to compare results. A searched cell represents a bounded query sweep, not exhaustive coverage.

Review pilot results, inspect false positives and spot-check missed curated sources. In Discovery runs, expand **Record Florida validation** and record actual checks and limitations. Actual independent searches, extracted source evidence, completed corpus import, positive check counts and written findings are required. Every job must be settled. A partial run may be reviewed only when all errors are documented website access limitations (such as a timeout or robots restriction) and the reviewer explicitly accepts them. The run remains partial and its errors remain visible. Internal errors, provider failures and unfinished work cannot use this exception; they require correction and a fresh pilot.

After that review, select one additional state in **State controls**, choose its categories and budget, and enable the desired capabilities. Other states remain off. Every state starts with statewide category searches; use **Extend geographic coverage** to add counties, municipalities, districts or regions. National eligibility is accepted only with explicit source evidence and remains subject to the selected state's switches.

Default provider reservation limits on a new installation: $3/day globally; $1/day, 4 queries and 25 pages per state. For the owner-authorized Florida initial fill on September 9, production was raised to $10/day globally and for Florida, with 20 queries and 200 page checks per day. These are independent ceilings, not guaranteed daily output. Conservative reservations can stop work before the query or page ceilings; reported actual token/search estimates are normally lower. Limits reset at UTC midnight. Budget-paused work also resumes after an authorized limit increase if capacity is available, without resetting prior usage. Other paused or failed work has an explicit resume action. Current model pricing is a configuration assumption that should be revisited when the provider changes pricing.

Imported watchlist and preserved snapshot records without a unique state clue are routed into Florida verification. This target reflects the Florida corpus context and never establishes eligibility, approves a source, or enables another state. Explicit other-state routes and source facts remain unchanged. Older known-source checks share chronological queue ordering with paid discovery and validation work so incoming discovery pages cannot continually bypass them.

## Automatic approval and publication

Automatic approval is enabled by default by migration eight, as requested by the owner. Turn it off in State controls to return to manual decisions. The worker approves newly verified funding programs and processes up to ten eligible backlog candidates each invocation without additional model calls. Source identity, funding evidence and state applicability remain required; open-cycle evidence is separately required for Radar publication.

Only a deterministic program-identity match suppresses creation. An exact imported match is upgraded in place, preserving opportunity and customer references. An exact approved match is linked to its existing program. Shared pages, shared parent organizations, similar names and semantic judgments do not block approval of a different program. Existing ambiguous duplicate records are retained; a confirmed incoming duplicate links to a deterministic existing target without deleting historical records.

Every automatic decision records a system origin and policy version in Decision history. It does not impersonate a human reviewer. Explicit prior human investigations, rejections and decisions are preserved. Missing or unsupported facts remain awaiting verification; this policy does not label unknown facts as verified. Unscanned imported records become eligible for automatic approval as the scheduled scanner verifies them.

Automatic approval uses evidence verified within seven days. Older pending candidates are scheduled for page verification automatically, within the existing state limits. Verification jobs are deduplicated and retry scheduling is spaced seven days apart; old evidence cannot silently publish as newly verified.

Approval, alias updates, audit history and initial open-cycle publication share one database transaction. State switches, the master switch and the existing daily provider limits remain in force.

### Optional manual review

The five-column import accepts `SOURCE NAME|URL|SOURCE_TYPE|GEOGRAPHY|KEYWORDS`, up to 100 rows per interactive import. Preview reports malformed rows and full-registry duplicate matches. Import preserves original text and sends valid candidates for verification and automatic processing. Download CSV or pipe format for manual analysis.

Existing curated entries initially appear as **Legacy unverified**. Missing organization, program, geography or source-type facts remain unknown. Verification can extract several actual programs from a single source page. Verified records follow the automatic decision policy; administrators can still investigate or correct records. Use **Update existing** for a verified version of an imported source so its durable references survive.

Review actions: approve new source, approve distinct program under an established parent, merge candidate with an existing program, update existing, reject with a reason, or investigate. Decisions and evidence are retained. Identity conflicts and stale reviews are rejected atomically. Domain similarity alone never merges programs. Combined legacy funder/program names are matched across changed pages, with optional manual investigation. Distinct programs may share an official grants hub. Explicit fiscal-year labels identify cycles. In manual mode, semantic comparison is advisory, limited to one call per fetched page, with a conservative reservation sized to its input and maximum output.

**Verify page** normally reuses unchanged extraction. **Re-extract page** explicitly requests a new model reading when facts are incomplete, within the same state budget. Deadlines without a stated year remain unstructured source excerpts. Only literal source dates and explicit open-application notices can support structured dates and publication.

The scanner supports bounded HTML/text/PDF reading, HTTP redirects, conditional requests and content hashes. Linux deployments explicitly include the PDF runtime's native dependency. CI extracts the actual function archive outside the checkout and reads a real PDF to detect missing packaged dependencies. It respects robots directives and does not bypass bot protection. Unreadable or unsupported sources remain available for investigation. Three transport failures mark temporary unavailability; discontinuation requires corroborating successful observations.

Only approved sources with evidenced applicability and an explicitly open cycle can publish. Cycle identity ignores changing deadlines within the same year. Closed or expired cycles are retained and hidden from active Radar; opportunity IDs, customer pipeline references and score history survive. Material changes invalidate cached summaries and mark scores stale for normal rescoring. Foundation Leads now reads the shared opportunity feed used by Radar. The old `foundation_scan_hits` table is preserved as an import source and history.

## Runtime and troubleshooting

`source-intelligence-background` checks durable jobs every five minutes. `source-intelligence-run-background` is the authenticated manual worker trigger. The existing daily `foundation-scan-background` entry point reconciles `funder_watchlist` and uses the same worker. SAM.gov, Grants.gov, health checks, billing and organization authorization retain their existing entry points.

Jobs have leases, bounded retries and active-key deduplication. Paused work is reused instead of repeatedly generating new scheduled jobs. A search processes at most two pages inline and queues remaining returned pages individually. One invocation processes at most one job that calls the model; corpus jobs can batch. Deploy previews cannot mutate the production source system.

Use run metrics, actual provider queries, errors and source scan history to distinguish no results, unsupported pages, eligibility failures, duplicate matches, budget pauses and provider access problems. Provider text alone cannot fabricate a search result: discovery requires actual web-search result blocks. Exact source excerpts back accepted claims; unknown amounts and yearless deadlines stay null.

To roll back processing, pause the engine. Existing Radar data stays available. Restore an earlier Netlify deploy only after considering that it restores the old scanner's behavior; keep the additive source schema and evidence history. Never run old setup scripts as a substitute for these migrations.

## Validation scope

Automated tests verify PostgreSQL migrations and role restrictions, review transactions, stale-review conflicts, budget/lease behavior, URL and program identity, state gates, quoted evidence, private-network blocking, full approval/publication flow, unchanged-page caching and repeat import linkage. Browser acceptance tests use synthetic data and are separate from the real Florida pilot. Record real pilot observations in `source_discovery_runs.validation`; do not present synthetic results as production research.

Provider references: [Anthropic web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Netlify background functions](https://docs.netlify.com/build/functions/background-functions/).
