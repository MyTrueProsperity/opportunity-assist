# Choice C: selective deterministic promotion

Implemented October 9, 2026 after Bill requested work on C. Bill then authorized continuing the official-source pilot and database/app release. The pilot reviewed five exact official pages using the existing robots-aware transport without any database write or paid model call. **Automatic publication remains disabled: none of those pages qualify under this first policy.** Release status and verification are recorded in the completion handoff.

The capability reduces routine human review only for genuinely new grants whose official evidence can be checked deterministically. Approval is a source decision, **not proof that a particular nonprofit qualifies**. Organization matching must still verify its geography, applicant prerequisites, capacity and timing.

## What qualifies

The initial policy supports a maximum of five individually reviewed, exact HTTPS official HTML page URLs. It does not treat a government-looking hostname, an imported statement or a model assertion as proof of authority. An administrator must review the source pilot and configure the URL and state.

Only the collector's own successful independent fetch can qualify. Injected fetchers, submitted evidence and fixtures are excluded. The existing transport retains robots checks, public-address validation, DNS pinning, redirect validation, request/response limits and pacing; a redirected source cannot qualify for C. No extra network request, model call or automatic backlog query is added.

A qualifying single-program notice has exact quoted evidence for:

- Program name and a grant funding mechanism.
- Plain state-wide geography and complete labeled applicant eligibility.
- An explicit positive current open-cycle statement.
- An unambiguous future ISO-date deadline.

Quotes must exist in the fetched visible text, refer to the same approved source URL and match the extracted values. The receipt records fetch time, whole-response hash, visible-text hash and evidence hash. The source cache, candidate and independent sighting must agree. Receipts expire after 24 hours; future observations and anything before the last activation/configuration boundary are refused. Freshness and UTC daily limits use wall-clock time after obtaining the database locks.

Unresolved reasons, invitations, closed/forecast notices, uncertain or multiple dates, PDF/attachment requirements, multi-program pages, county/complex geography and unsupported amounts stay in the review queue. Optional amounts must also have exact source quotations. A separate application URL requires human review in this first policy. These strict rules deliberately limit initial coverage.

Only a new pending candidate with its first verified observation can be promoted. Existing identities, aliases, similarities, changed canonical records, older candidates, earlier sightings and all previous human decisions stay manual. The collector preserves existing candidate fields and decisions when adding a changed C observation.

## Guards and transaction

Two new switches default off: Functions-scoped HARVESTER_DETERMINISTIC_PROMOTION_ENABLED must be exactly true, and the database deterministic_promotion_enabled must be true. Existing HARVESTER_PRODUCTION_ENABLED, engine/state controls, automatic_approval_enabled, publication controls, validated-state restrictions and page/job budgets remain separate requirements. C does not enable any of them.

The database independently checks the locked candidate against the current source configuration and saved source observation. It constructs its own approval/publication payload from that row; the caller cannot supply replacement public fields. It shares the existing identity lock, holds the settings row lock and rechecks canonical collisions before creation.

At most five eligible requests are attempted per collector call, and at most five audited C checks across all states/sources per UTC day, reducible to zero. Denied database checks and failed publication attempts consume that ceiling. A quota refusal remains a pending item. C never drains the historical backlog or automatically retries a failed/unchanged observation.

Approval, source/cycle publication and successful decision records commit together. A failed publication rolls back the new program, candidate approval, cycle and approval decision, while a private failed-attempt receipt is retained and consumes the daily allowance. The failure requires human review without a retry loop. Missing database support fails closed. Successful decisions identify the deterministic policy, never pretend to be human review.

The private source_deterministic_decisions audit table has RLS and no anonymous/authenticated access. Both new functions use SECURITY INVOKER, revoke PUBLIC/anonymous/authenticated execution and permit service_role execution only. Administrator configuration additionally validates the administrator identity and records a human configuration decision.

## Files

- netlify/lib/source-intelligence/deterministic-promotion.js: bounded receipt, policy evaluation and promotion wrapper.
- netlify/lib/source-intelligence/harvester.js: default-off narrow official-page integration and preserved prior decisions.
- netlify/functions/source-intelligence-admin.js: authenticated configuration endpoint.
- assets/source-intelligence.js: honest status/review/failure guidance.
- supabase/migrations/20261010002826_source_deterministic_promotion.sql: registered using the checksum-verified Supabase CLI v2.120.0; defaults off. docs/local-proposals/deterministic-promotion.sql mirrors it for review.
- tests/deterministic-promotion.test.js: policy, PostgreSQL transaction/authorization and collector/browser regressions.

B's official-page adapter and shared detail-facts.js are dependencies. The adapter's state parser uses the existing assets/matching.js statesIn export. Include those dependencies in an isolated release against current main; preserve the published grant-writing release and the newer research budget controls. Do not deploy the entire accumulated local development checkout without reviewing its unrelated A/D/E/F/G changes.

## Release and activation

1. Review the isolated code/database diff and local verification. The migration was registered with the Supabase CLI. Run advisors/security checks and apply through the established database release process; this installs the capability with its settings disabled.
2. Review at most five named official source pages in a read-only pilot. Compare each proposed field with the actual complete notice. Do not use fixtures as proof of live coverage.
3. Review enabled states, daily budgets and queued work. Existing automatic_approval_enabled defaults true in an earlier migration and can affect the old deliberate provider path. C does not change that legacy setting or remove its existing service-level harvested-record block.
4. Deploy the reviewed app/function changes through a branch and PR. Keep both C switches off until the pilot and activation are explicitly approved.
5. An authenticated administrator can POST to /.netlify/functions/source-intelligence-admin with action configure_deterministic_promotion, enabled, sources and daily_limit (0–5). Each source is {url: EXACT_REVIEWED_HTTPS_URL, kind: official-page, state: STATE_CODE}. Enabling additionally requires confirmation ENABLE_DETERMINISTIC_PROMOTION_AFTER_OFFICIAL_PILOT. This is an explicit human attestation, not automatic proof that a pilot happened. The configuration call starts a fresh server-side boundary and does not enqueue jobs or change other controls.
6. Set the separate Functions deployment switch and redeploy only after authorization. Observe audited decisions and exception reasons before expanding. No paid model is involved, but normal hosting/database/source-request resource use can still apply.
7. Pause by disabling the C deployment switch or administrator setting; either suffices. Already published grants keep their audit/history. Existing source monitoring and human review remain available.

## Verification limits

Offline tests use synthetic pages, simulated collector transport and in-memory PostgreSQL. CI also exercises independent sessions in an isolated PostgreSQL 17 container with no network or exposed port. They prove the local policy, database guards and transaction behavior; they do not establish real-source coverage or paid narrative quality. Final full-suite/build/function-check counts and logs are recorded in the C completion handoff.

## Official-source pilot

See [the five-page pilot](deterministic-promotion-pilot.md). No page passed. The pilot is evidence that the safeguards refuse those notices, not proof of successful live auto-publication. Do not enable C or relax evidence requirements merely to make a pilot pass. Broader coverage needs adapters that reliably distinguish current cycles from historical ones and read complete eligibility rules and linked application requirements.
