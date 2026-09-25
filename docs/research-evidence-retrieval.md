# Research evidence retrieval

Grant Factory's **Research Library** reads versioned research packages from the private `research_evidence` schema. The Institute package is `CENTRAL_FLORIDA_SEMINOLE_COUNTY_V1_2026-09-22`. The full corpus belongs in the database and private bundle, not this public repository or the static website assets.

## Access and claim boundaries

The existing Grant Factory function validates the sign-in token and workspace membership. Its server-side database connection calls three `SECURITY INVOKER` RPCs: `gf_research_bundle`, `gf_research_search`, and `gf_research_document`. Only `service_role` can execute them. Each RPC requires a real `gf_members` match, an explicit `package_workspaces` assignment, and an **active** package. Anonymous and authenticated browser database roles have no direct research access. No custom schema needs to be exposed through the Data API.

`research_evidence.guarded_evidence` is the original administrative staging view; it is not the application's retrieval endpoint. The new RPCs enforce package status and workspace assignment independently.

Canonical evidence becomes read-only virtual facts at retrieval time; it is never inserted into `gf_facts`. Only records with `PRIMARY_VERIFIED`, a verification date, and `review_before_external_use=false` qualify for drafting. The original verification scope, geography, year, population, methodology, supports, limits, prohibited wording and QA flags travel with each fact. The AI writer, strategist and auditor receive the package's claim rules. The deterministic audit also blocks common ALICE/poverty and wage-geography/entry-pay mistakes. Other semantic rules require the existing AI audit and human review; do not describe these as a complete automatic claim validator.

Stable evidence identifiers incorporate the package version and record ID. Evidence and rule-content hashes invalidate prior audits when either changes. Retiring a package removes its evidence from future authorized retrieval; recorded submission snapshots remain historical. Existing organization facts and permissions are unchanged.

The 541 research sections are **background only**, with full-text search and twenty results per page. Packet narratives and background prose are never passed as authorized drafting evidence. The source library provides provenance; the complete master Markdown volume is available through an authenticated download. CFSC-010 resolves to CFSC-025; CFSC-037 resolves to CFSC-009. Undefined CFSC-011 and CFSC-012 produce no canonical record.

CFSC-041 remains verified with its explicit table-14.1% versus narrative-14.0% caution, which is displayed and passed to the writer/auditor. Its inclusion in the review queue does not erase the checked table value. There are 12 draft-eligible records and 31 records requiring review; the review queue contains 32 entries.

## Migration history and loading

Following the existing isolated Grant Factory migration layout, research migrations are under `supabase/research-evidence/`. They depend on the existing `organizations` and `gf_members` tables. Do not run them through the independent Source Intelligence fixture or blindly replay them against production.

- `20260923000108_research_evidence_namespace.sql`: exact supplied migration already recorded in the live database by the staging import.
- `20260923003402_research_evidence_retrieval.sql`: protected retrieval, workspace assignments and master-document parts. Its filename matches the live migration history.
- Record-ID namespace migrations, one per research volume, recovered byte-for-byte from `supabase_migrations.schema_migrations` (never re-run them against production): `20260923184152` CB, `20260923190159` AM, `20260923190246` EP, `20260923192707` EM, `20260923193828` NC, `20260923210805` CTE_*, `20260925132115` GW, `20260925132215` CNE, `20260925133347` YW, `20260925154408` BM-ENT-V1. Applied in order they reproduce the production `evidence_records_record_id_check` exactly; `tests/research-namespace-alignment.test.js` enforces that, and that `RECORD_ID` in `scripts/prepare-research-package.cjs` accepts the same namespaces. A new volume prefix needs a new narrow migration, the matching `RECORD_ID` change and an update to that test.

To prepare missing background data from a private bundle:

```sh
node scripts/prepare-research-import.cjs /path/to/private/bundle work/research-import
```

This verifies the entire `SHA256SUMS.txt` manifest, then writes resumable, SQL-escaped batches. Execute numbered batches sequentially through a trusted database connection. Each batch requires the package to remain staging. The generator is for this V1 completion and expects the canonical package to have been loaded already; it does not bootstrap the evidence, packets, rules, aliases or review queue. Never commit generated SQL batches, private research or credentials.

Execute every `check_*.sql` query after loading. Each result's `expected` must equal `matching`. These check JSON **value equivalence** with the source, not the original whitespace or key ordering, which PostgreSQL JSONB does not preserve. Separately verify the master file's UTF-8 checksum after concatenating parts in `part_number` order. The V1 SHA-256 is `b93ba7d465aec921a8f29a4107e40cd2563ac0db3443501034eeb6b0ccbc91e2`.

Activation is a separate transaction after verifying 43 evidence records, 20 statistics, 9 packets, 34 rules, 4 aliases, 32 review entries, 541 sections and 273 sources. Insert the intended organization into `package_workspaces`, then set this package to `active` with `activated_at`. Do not give other organizations implicit access. Keep the source metadata as provenance; record live import details separately in `metadata.runtime_import`.

An active package must record when it was activated. `20260925152433_research_evidence_active_requires_activated_at.sql` adds the check constraint `packages_active_requires_activated_at` (`status <> 'active' or activated_at is not null`), so setting a package active without `activated_at`, or clearing it while active, fails. Staging and retired packages may keep a null value. Retrieval still gates on `status = 'active'` plus a workspace assignment; the constraint only keeps the activation record complete. When a past activation time cannot be established exactly, record the documented basis for the value used in `metadata.runtime_import` rather than inventing one.

## Grant-writing volume (GRANT_WRITING_APPROVAL_RESEARCH_V1_2026-09-24)

The "How to Write Grants That Get Approved" volume (Parts 1 to 6, E-01 to E-116) is a separate package assigned only to the Institute workspace. It holds funder rules, reviewer records, grant-process research and guidance. None of it is an organizational fact: it does not establish Bright Minds eligibility, adoption of any framework, partner commitments, evidence tiers or outcomes.

- Record IDs are `GW-nnn`, keeping the original sequence (E-07 is GW-007). All 116 original IDs are package-local aliases. `20260925132115_research_evidence_grant_writing_ids.sql` adds the GW namespace with the same narrow pattern as earlier volumes.
- 113 records were created. E-105, E-109 and E-116 duplicated existing canonical records (CFSC-028, EM-002, NC-035: same source and finding), so no GW record was made; their aliases carry `MERGED_CROSS_PACKAGE` with a null canonical ID, and the existing records gained a `cross_volume_enrichments` entry plus the new limits appended to `does_not_support` and `prohibited_language`. Their findings, approved language, verification status and draft eligibility were not changed.
- 109 records are draft-eligible. Four are `PARTIALLY_VERIFIED` and in the review queue: GW-030 and GW-031 (the funder's two pages state an application limit differently), GW-102 (brief checked, full report not audited) and GW-113 (two clearinghouse reviews disagree by outcome).
- Ten package claim rules (`GW-CR-01` to `GW-CR-10`) carry the volume's prohibited transformations: geography transfer, external outcomes as Bright Minds outcomes, plans as results, interest as commitment, score as award, citation as adoption, clearinghouse evidence as a rating, templates as approved language, approval probabilities and cycle-specific funder rules.
- The Part 6 crosswalk, claim library, measurement crosswalk and language check are background sections labeled as editorial methodology candidates. They are not evidence and not pre-approved language. Two organization-neutral rules drawn from them were added to `methodology.js` (GM-17 status claims, GM-18 measure definitions); the rest duplicated GM-05, GM-09, GM-10, GM-14 and GM-16. The workspace planning framework was not changed.
- Program links name only existing program records and are relevance, not facts. Unresolved components with no program record: dual enrollment, paid student work and internships, a separately defined mentoring component, arts/media/performances and employer partnerships. Graduate Defense maps to the Academy as its signature component.
- Six package records had source lists that absorbed the rest of their Part (E-25, E-45, E-65, E-77, E-97, E-116). Attribution was resolved from each record's own source line; the supplied lists remain in `source_fields_original`, which is server-side only.

`scripts/prepare-research-package.cjs` validates a private bundle and emits resumable SQL batches with value checks for any package in this format. The live load of this volume used equivalent compact batches (master text sent once; section bodies and record Markdown cut from it server-side) and was verified by md5 of the canonical jsonb text for every row. Never commit the private bundle or generated SQL.

## Entrepreneurship Volume 1, recovered (BRIGHT_MINDS_ENTREPRENEURSHIP_V1_RECOVERED_2026-09-25)

A partial, normalized recovery of the Institute's Entrepreneurship research, assigned only to the Institute workspace. It is research, not organizational fact, and not a grant-opportunity feed.

- **Completeness boundary.** Register entries 33 to 301 plus 85 supplementary findings, associated with Sections 149 to 1021. Sections 1 to 148 and register entries 1 to 32 are missing, and the master is a normalized reading edition, not a verbatim transcript. The package metadata records this (`archival_completeness`, `completeness_boundary`, `missing_material`). Volume 2 is separate and was not imported, restarted or renumbered.
- **Record IDs** keep the package's own canonical IDs (`BM-ENT-V1-Ennnn`, `BM-ENT-V1-Snnn`); `20260925154408_research_evidence_entrepreneurship_v1_ids.sql` adds that namespace. Observation IDs (`BM-ENT-V1-Lnnnn`) are aliases.
- **341 package canonical records:** 269 evidence rows; 3 exact cross-volume duplicates merged into AM-042, AM-040 and CTE_FUTURE_002 (alias `MERGED_CROSS_PACKAGE`, a `cross_volume_enrichments` entry on the existing record, nothing else changed); 69 records with no recovered source URL kept only as background register text (alias `QUARANTINED_SOURCE_NOT_RECOVERED`). Overlapping but distinct records (for example E0081 with CFSC-007/046, S075 with CFSC-001/NC-001) stay separate and list `related_existing_record_ids`.
- **20 draft-eligible records**, each a bounded record-specific check re-fetched during import on 2026-09-25 (QuickFacts, FinCEN BOI, SBA combined 7(a)/504, IRS 1099-K, WWC review, BFS release, Seminole State incubation/ELLE/SABC criteria). E0114 (SOP 50 10 8.1, future-effective October 1, 2026) and E0286 (undated SABC pause) are `PARTIALLY_VERIFIED` and restricted. The other 247 are `CONVERSATION_ONLY`, in the review queue, and their `approved_language` begins `RESTRICTED:`. Both 2025 Seminole business-application values (S001) stay quarantined.
- **35 package claim rules** (`BM-ENT-V1-R01` to `R35`): drafting constraints are `block`/`semantic_review`; import-process rules are `info`/`import_process`.
- **Background:** 681 sections sliced from the master; interpretation candidates, program packets, gaps and the source registry are background only. Priority statistics are a flag (`priority_reference`), not extra rows.
- **Programs:** links point only to existing program records and are relevance, not facts. Unresolved labels with no program record: Business / Finance / Entrepreneurship, Marketing / Media / Communications, Skilled Professions / Operations, Leadership / Public Service, and Paid work, internships and dual enrollment.
- **Browser payload.** After this volume the Grant Factory brain response measured about 5.2 MB uncompressed (about 0.67 MB gzip). That is close to the 6 MB synchronous function response limit, so check the payload size before activating another large volume.

## Validation and operation

```sh
pnpm test
pnpm build
pnpm check:functions
```

The research tests cover staging/retired suppression, cross-workspace denial, service-only execution, review exclusion, rule-change audit invalidation, background/master isolation, read-only virtual facts, and writer/auditor guard propagation. Optional local UI validation accepts `RESEARCH_PREVIEW_BUNDLE=/path/to/private/bundle` with `node scripts/grant-factory-preview.js`; it uses isolated in-memory data and no live AI.

Use the existing Netlify deployment pipeline and server environment. No new secret or browser credential is needed. Deploy through the repository's Linux build so optional native PDF dependencies match production.

To turn retrieval off without deleting data, set this version to `retired` (or return it to staging) or remove its workspace assignment. Do not drop the schema for an application rollback. Deactivating research can require re-auditing pending drafts that cited it; already recorded submission snapshots remain intact.

The Supabase advisor's “RLS enabled, no policy” information for the private research tables is expected: browser roles are denied and the authenticated server uses the restricted RPC boundary. Existing unrelated project warnings are outside this change. See the [Supabase privilege and RLS guidance](https://supabase.com/docs/guides/api/securing-your-api).
