# Grant Factory Phase 1 deployment and operating guide

## Release boundary

This module extends the existing Opportunity Assist application. It does not deploy itself, change existing organizations, alter Source Intelligence, or submit anything to a funder. The source baseline is main commit `fdfe541`. Reconcile any newer main changes before merge, especially edits to `app.html` and the function packaging configuration.

The repository is public. Institute facts and the supplied report are intentionally excluded from Git and the static site. Keep the separately delivered `Institute-Grant-Factory.private-seed.json` private. It contains 6 programs, 92 facts, expected document records, and the exact report bytes; an executive imports it into private storage through the application. Do not place the file in `assets`, `dist`, a public repository, or a public deployment artifact.

## Install and verify

Use Node 22 or later and the repository's pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm check:functions
```

The original 111 tests continue to run unchanged. New tests use PostgreSQL via PGlite and a bounded test AI adapter. Public CI uses a synthetic seed pack; local acceptance also runs against the actual supplied report and private Institute import. `node scripts/grant-factory-preview.js` runs a local browser preview on port 8794 with isolated data and live AI disabled. It must never be deployed as a production server.

## Database and access setup

Apply these additive files to the existing Supabase project in order:

1. `supabase/grant-factory/202609170001_grant_factory.sql`
2. `supabase/grant-factory/202609170002_private_storage.sql`
3. `supabase/grant-factory/202609170003_voice.sql`
4. `supabase/grant-factory/20260917194455_grant_factory_security_hardening.sql`

The fourth migration revokes explicit hosted anonymous function grants and pins the immutable-history trigger's search path. The authenticated role lookup remains intentionally callable for RLS and returns only the signed-in user's protected membership for the requested organization.

They are separate from the historical Source Intelligence migration runner because that runner's test fixtures do not include the Opportunity Assist core schema. Apply them explicitly during this release. They require existing `organizations`, `profiles`, `opportunities`, Supabase Auth roles, and Supabase Storage.

Provision access using `docs/grant-factory-provision.sql` after identifying the actual Institute organization and executive profile ID. The template refuses to run until those required IDs are supplied; the manager ID may stay null until that person has an existing, verified account. Bill should be OWNER and Claudia GRANT_MANAGER only after their real accounts and access are approved. No user is assigned authority by matching a name or by editing their client-writable profile. Only trusted database administration may alter memberships.

Grant Factory memberships are separate from a profile's primary Opportunity Assist organization. A person can select only explicitly provisioned organizations in the Grant Factory header, with the role checked for that organization on every request. Provisioning Institute access does not move the person's existing profile or affect their other Opportunity Assist work. Saved applications, facts, documents and drafts stay within the selected workspace.

All `gf_*` tables have row-level security. Browser roles have scoped reads and no direct write permission. Mutations are server-only and membership checked. Facts and documents marked RESTRICTED are owner-only; detailed immutable history and archived submission packages are owner-only. Grant managers can export the current application, assemble attachments and review narrative answers, but cannot approve institutional truth or final submission.

The private `grant-factory` storage bucket has no public or general authenticated object policy. Membership-checked server routes mediate uploads/downloads. Every original is stored under an organization and document ID and checked by SHA-256. Files are never overwritten. New uploads produce new document identities; the checklist chooses the intended version explicitly.

## Function configuration

Reuse existing Netlify function environment variables:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY`

Optional: `GRANT_FACTORY_MODEL`, defaulting to the repository's existing Anthropic Haiku model family (`claude-haiku-4-5-20251001`). No OpenAI account or API is needed by this implementation.

The AI calls require up to 45 seconds each, plus database access. Confirm the deployment's synchronous function timeout supports this; otherwise use a longer supported function timeout or split the calls into a durable task runner before enabling live use. Drafting and auditing are separate user actions, never a hidden batch. Per-organization limits are 120 AI calls per UTC day and 4 active calls within a two-minute window, enforced under a database lock. Tokens, model, failures and completion times are recorded in `gf_ai_runs`.

Do not put service credentials in `app.html`, source control or public assets. The model receives only task-specific authorized evidence. Restricted documents cannot go through AI fact extraction. Uploaded instructions are treated as untrusted source content.

## First use

1. Sign in with the provisioned executive account, open Grant Factory and confirm the Institute organization in its header.
2. Import the private Institute seed file. The import is idempotent and preserves previously edited seed records.
3. Review Truth Review and upload governing documents. The expected-document list is a collection checklist, not proof that documents exist.
4. Confirm the legal name against current corporate records; the supplied name is user-confirmed, with document confirmation pending. Confirm Board records, legal officer authority, EIN, tax-exempt evidence, addresses and budgets.
5. Create an application by uploading PDF/DOCX/text or pasting the complete text. Link a related Funding Radar opportunity if appropriate.
6. Review every extracted field/limit against the original. AI parsing can supplement the deliberately conservative basic parser. Confirm eligibility and required attachments.
7. Choose primary/supporting programs, edit the strategy and approve it for drafting.
8. Draft narrative questions one at a time. Save manual edits with supporting evidence. Resolve Needs My Input as application-specific information or a proposed reusable fact; only executive-approved information becomes usable truth.
9. Audit claims independently, fix unsupported or overstated claims, and review each answer. Certification/signature/budget fields are human-entered and require executive commitment review.
10. Run QA, complete executive approval, and export. The ZIP contains `application.docx`, approved attachments, and a clearly labeled `INTERNAL-REVIEW` folder. Review files before sending; the internal manifest is not a funder attachment.
11. A person submits through the funder's process. Enter the receipt/confirmation to create an immutable submission snapshot. Later edits require a new application record. Snapshot export preserves what was submitted even if the current truth set changes.

## Phase 1 limits and deployment checks

- Supported reference files: text-based PDF (up to 500 pages), DOCX and UTF-8 text; 3 MB per file and 1,000,000 extracted characters. No OCR, spreadsheets, image extraction, portal login or autofill. Pasted application text remains bounded to 100,000 characters.
- Word counts use whitespace-delimited tokens; character counts use NFC-normalized Unicode code points. The funder's own counter is authoritative when its convention differs. Page limits and ambiguous character rules require a manual layout check.
- Evidence retrieval uses bounded keyword relevance, not embeddings. Program recommendations are explainable keyword matches requiring a human choice.
- Eligibility comparison is conservative: explicit exact-match facts may pass/fail; missing facts and legal/financial requirements remain uncertain or require review. There is no automatic external legal or eligibility research.
- The claim auditor is an independent model call plus deterministic guards, not a guarantee of truth. Human review remains mandatory. The deterministic rules intentionally err toward review for commitments, projections and historical outcomes.
- Exports are DOCX, JSON provenance and ZIP packages. Portal-ready PDF layout is not generated; page-limited applications require human formatting review. ZIP responses are bounded to fit the Netlify response size, and larger files can be downloaded individually.
- AI/provider and live Supabase/Storage behavior must be tested after deployment with the real environment. The local workspace has no live provider/database credentials. Local tests prove transaction, permission and workflow behavior with controlled fixtures, not live model accuracy.
- A database/storage operation that fails after object upload may leave an unreferenced private object. It is never publicly accessible. Review such objects during maintenance; there is no automated deletion job in Phase 1.
- The September 15 Director commit references a migration absent from main. Confirm those pre-existing tables remain present in production. This module intentionally does not modify them.
- Some original ChatGPT specification messages were clipped by the retrieval service. Later explicit user decisions and recovered overlapping specifications were used; inaccessible text was not invented.

## Phase 2 recommendations

### September 23 guided intake update

Grant Factory now opens on **Start here** with three actions: add documents, review suggested facts, and start an application. The vault separates uploaded originals from the optional document checklist. Fact readiness comes from the same server authorization used by drafting; an approved fact whose source has not been approved is explicitly marked unavailable, with the reason shown.

**Read & suggest facts** processes at most 10,000 source characters per request. Each successful request atomically saves pending fact proposals and `gf_documents.content.fact_extraction` progress. The browser continues sequentially while the reading dialog is open. Closing or pausing stops after the current section. A later session resumes from the saved cursor. A failed section never erases completed sections. Cursor replays return saved progress without repeating AI calls, and exact repeated source/value proposals are deduplicated. Concurrent writes remain guarded by the existing workspace revision lock. There is no new queue or cron task, and the existing 120-call daily AI limit remains.

Reading does not approve facts or source documents. The simplified fact-review dialog requires an explicit owner choice and source acknowledgment. Source approval and fact approval commit together. Restricted sources remain excluded, and history and private storage remain unchanged. Completing document processing means all text sections were processed, not that every possible fact was extracted or verified. Extraction warnings remain visible.

Quote recovery repairs whitespace-only copying differences by storing the exact original excerpt. A misplaced locator is repaired only when the quotation matches one source block in the current section. Untraceable or ambiguous suggestions are omitted with a saved warning and cumulative count, while traceable suggestions are retained for human review. If none of the returned suggestions can be traced, the section remains pending for retry.

If a slow request loses its response, the reader checks saved document progress for up to seven reads, five seconds apart. A confirmed cursor advance resumes the normal reading flow without replaying the AI request. Unconfirmed work remains paused; explicit application errors are not retried. The source fingerprint prevents recovery from accepting progress from a replaced document.

Repeated drafting replaces unanswered automatic input requests for that question, while preserving responses and resolved history. The application explains review prerequisites and hides drafting until the question list and strategy are reviewed. Every draft reloads the current organization facts; re-parsing an application is not necessary to use newly approved evidence.

After several real grants have completed human review, evaluate live-model extraction/claim-audit precision, add OCR and resilient background jobs, then consider semantic retrieval and cross-application input deduplication. Advanced request-size intelligence should use actual giving history and current budgets. Add awards/declines, reporting and Board reports only in a later scoped release. Portal automation, harvesting and auto-pursuit require separate approval and implementation; none is introduced here.
