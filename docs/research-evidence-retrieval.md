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

To prepare missing background data from a private bundle:

```sh
node scripts/prepare-research-import.cjs /path/to/private/bundle work/research-import
```

This verifies the entire `SHA256SUMS.txt` manifest, then writes resumable, SQL-escaped batches. Execute numbered batches sequentially through a trusted database connection. Each batch requires the package to remain staging. The generator is for this V1 completion and expects the canonical package to have been loaded already; it does not bootstrap the evidence, packets, rules, aliases or review queue. Never commit generated SQL batches, private research or credentials.

Execute every `check_*.sql` query after loading. Each result's `expected` must equal `matching`. These check JSON **value equivalence** with the source, not the original whitespace or key ordering, which PostgreSQL JSONB does not preserve. Separately verify the master file's UTF-8 checksum after concatenating parts in `part_number` order. The V1 SHA-256 is `b93ba7d465aec921a8f29a4107e40cd2563ac0db3443501034eeb6b0ccbc91e2`.

Activation is a separate transaction after verifying 43 evidence records, 20 statistics, 9 packets, 34 rules, 4 aliases, 32 review entries, 541 sections and 273 sources. Insert the intended organization into `package_workspaces`, then set this package to `active` with `activated_at`. Do not give other organizations implicit access. Keep the source metadata as provenance; record live import details separately in `metadata.runtime_import`.

## Additional complete research packages

`scripts/prepare-research-package.cjs` loads complete private packages into the same tables, including canonical evidence, statistic groups, rules, packets, source reviews, aliases, background sections, sources, and master document parts. It validates manifest hashes, canonical-file/payload agreement, foreign references, and drafting eligibility before emitting staging-only SQL batches. Use it as follows, then execute every generated check and verify the master checksum before assigning a workspace and activating the package:

```sh
node scripts/prepare-research-package.cjs /path/to/private/bundle work/package-import
```

Community and Belonging IDs are supported by migration `20260923184152_research_evidence_community_belonging_ids.sql`. Migration `20260923210805_research_evidence_cte_ids.sql` additionally accepts the original CTE IDs while preserving every existing namespace in the live constraint. These are additive import-compatibility changes; they do not change retrieval permissions or introduce new tables.

The CTE package retains original record fields, source-quality tiers, causality labels, geography hierarchy, funding tags, retrieval bundles, claim cautions and cross-volume links in the existing JSON payloads. Composite statistics retain named components rather than being forced into a misleading scalar. Repeated studies across volumes are linked as the same study, not independent corroboration. Background sections stay background-only. The unresolved FloridaCommerce 2026–27 LWDB 12 row extraction is package gap metadata and a claim rule, never fabricated occupation rows.

Private package manifests and live validation receipts belong with the private ingestion artifacts, not the public application repository. No application deployment is necessary to retrieve a newly activated package through the existing RPCs.

## Repository checks

```sh
pnpm test
pnpm build
pnpm check:functions
```

The research tests cover staging/retired suppression, cross-workspace denial, service-only execution, review exclusion, rule-change audit invalidation, background/master isolation, read-only virtual facts, and writer/auditor guard propagation. Optional local UI validation accepts `RESEARCH_PREVIEW_BUNDLE=/path/to/private/bundle` with `node scripts/grant-factory-preview.js`; it uses isolated in-memory data and no live AI.

Use the existing Netlify deployment pipeline and server environment. No new secret or browser credential is needed. Deploy through the repository's Linux build so optional native PDF dependencies match production.

To turn retrieval off without deleting data, set this version to `retired` (or return it to staging) or remove its workspace assignment. Do not drop the schema for an application rollback. Deactivating research can require re-auditing pending drafts that cited it; already recorded submission snapshots remain intact.

The Supabase advisor's “RLS enabled, no policy” information for the private research tables is expected: browser roles are denied and the authenticated server uses the restricted RPC boundary. Existing unrelated project warnings are outside this change. See the [Supabase privilege and RLS guidance](https://supabase.com/docs/guides/api/securing-your-api).
