# Grant Factory Phase 1: implementation map

Baseline: `fdfe541fcb5948dcd076362bdff204aff08411e8` (main, 17 September 2026).

## Existing architecture and coordination

Opportunity Assist is a vanilla JavaScript single-page application in `app.html`, with static assets, Supabase Auth, Postgres and row-level security, REST data access, and Netlify CommonJS functions. There is no ORM. Existing AI functions use Anthropic Messages. Source Intelligence has its own durable job queue, provider adapter, audit trail, and administrator authorization. Scheduled crawlers and billing remain existing subsystems. Tests use Node's test runner and PGlite; deployment packaging uses Netlify's function bundler. No general document vault, organization facts ledger, or grant-writing workflow exists.

Reuse organizations, profiles, opportunities, pipeline items, Supabase sessions, the existing deployment and visual language. Add organization-specific programs separately from `funding_programs`, which describe funder opportunities. Add dedicated grant workspace memberships because existing profile updates are client writable and do not establish executive approval authority. Reuse the Anthropic provider protocol, with a separate constrained adapter for grant tasks.

Current main preserves the September 15 Opportunity Director pursue/pass, requirements and activity UI and the September 17 startup/Contract Watch fixes. The Director commit says a `202609150001_director_layer.sql` migration was tracked, but that file is absent from main; live database verification is a deployment prerequisite. Do not reconstruct or overwrite that unrelated feature.

The older local Source Intelligence checkout is on `42b52f3` and has uncommitted changes in `assets/source-intelligence.js`, `netlify/functions/source-intelligence-admin.js`, three files under `netlify/lib/source-intelligence/`, and `tests/workflow.test.js`. Those files and that checkout are left untouched. Grant Factory is implemented in an isolated clone on `codex/grant-factory-phase-1`.

## Module boundaries

- Frontend: isolated `assets/grant-factory.js`, CSS and shared deterministic limit functions; small app-shell integration.
- Backend: authenticated `grant-factory` endpoint and dedicated `netlify/lib/grant-factory/` modules for authorization, repository access, extraction, parsing, evidence, writing, audit, QA, export and seed data.
- Persistence: additive `gf_*` tables, organization-scoped read policies, server-only mutations, explicit owner/manager memberships, optimistic revisions and transactionally immutable submission snapshots.
- Documents: private Supabase Storage bucket, original bytes and SHA-256, bounded PDF/DOCX/text extraction, stable source locators, explicit extraction errors. Unreviewed extracted document facts are proposals. The supplied Institute seed and original report are imported from a private file; neither is committed to the public repository or bundled into the static site.
- Generation: question-scoped approved evidence, projected-language rules, deterministic limits, independent claim audit, per-organization AI run limits and recorded failures. Uploaded text is untrusted evidence, never instructions.
- Approval: owner approves institutional truth and final application; managers edit, assemble and export drafts. Legal/financial/certification commitments require explicit owner review. Changed facts invalidate prior review through a workspace revision.
- Workspace selection: protected Grant Factory memberships determine available organizations and the current role. The user's existing primary organization remains unchanged; every requested workspace is checked against independent membership before data access.
- Phase 2: no new harvesting, auto-pursuit, portal login/submission, email monitoring, awards/reporting automation or advanced request-amount inference.

## Source precedence

The latest explicit user Truth Review answers supersede earlier seed defaults: BANK ROLL'D INC. legal name is user confirmed with document confirmation pending; fiscal year is January–December; board officers are user confirmed pending documents; John Doe initiative is at least once before graduation; professionalism is graded and service is not; blazer is earned; theater is primarily student with possible community productions; artwork may be sold; movies include teens and families; financial capability is formal and embedded.

The attached Bright Minds Impact Report is retained intact with paragraph provenance. Historical record, planned Institute outcomes, incomplete denominators, participant perspectives and causal limitations remain distinct. Some very long ChatGPT messages are clipped at 20,000 characters by the conversation retrieval service; recovered overlapping specifications and later explicit decisions govern implementation, and inaccessible tails are not invented.
