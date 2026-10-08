# Bounded operator-invoked research

## State and scope

This draft implements a usable but **disabled-by-default** targeted research path.
It caps OA research API usage at a $10 initial stage and an absolute $85 per
explicitly verified credit cycle. It aims for near-zero out-of-pocket cost;
it does **not** guarantee promotional-only funding.

Routine token-free discovery, FinCap, other product AI features and existing
schedules are unchanged. No new HTTP endpoint, recurring job, credential, billing
change or account linkage is added. The operator CLI uses existing server
configuration only after the deployment and database gates below pass.
No live paid call, production migration, enablement or production deploy has
been performed by this work. The SQL remains a review proposal outside migrations.

## Gates and accounting

- `OA_RESEARCH_ENABLED=true` and
  `OA_RESEARCH_FALLBACK_RISK_ACCEPTED=true` are both required in the approved
  execution environment. Neither flag alone enables work.
- The DB cycle must independently be enabled, acknowledge fallback risk, have
  verified start/expiry and price validity, and contain a matching reviewed
  plan hash **and** review reference. No cycle or approval is seeded by the SQL.
- A recent operator-verified promotional balance must be recorded. It is accepted
  for at most one hour, less the dispatch safety margin. Future timestamps and
  stale/missing snapshots fail closed. This is a risk-reduction check, not an
  atomic guarantee against other applications spending after the observation.
- The DB subtracts at least $15 for other apps and **all** this cycle's research
  reservations from the balance snapshot before admitting another request.
  If the snapshot already reflects earlier research, this double-counts those
  reservations conservatively. Refreshing a balance never resets the dollar caps.
- Integer microdollars are used. Default trial/stage limit $10; absolute ceiling
  $85. A nonempty expansion review is required to raise the stage above $10.
  All recorded cycles, even disabled ones, prevent overlapping cycle IDs from
  manufacturing fresh headroom. No calendar-month or automatic balance reset.
- Reserve maximum exposure durably before the provider request. A short
  PostgreSQL mutex-row transaction allows only one pending research request
  across workers. The provider call is outside the transaction.
- Retain the entire reservation permanently, even when actual usage is lower.
  Store final token usage, calculated actual cost, proposal and provider request
  ID separately. This intentionally underuses the allowance rather than refunding
  uncertain headroom.
- Duplicate attempts and duplicate request hashes cannot send again. There are
  no automatic retries or fallbacks. Timeout, HTTP error, unsupported usage,
  crash or reconciliation failure keeps the reservation and blocks later work.
  A lost reserve acknowledgement leaves a pending attempt; do not blindly retry.
- DB expiry and price checks allow 90 seconds plus a five-minute margin. Dispatch
  rechecks the returned deadline and a server-derived window against monotonic
  elapsed time, so a slow application clock cannot extend admission.
- The provider uses one raw `fetch`, fixed first-party endpoint, redirects
  disabled, a 90-second timeout, standard-only tier and a 256 KiB response cap.
  A timeout does not prove the provider stopped billing.

These controls govern this research entry point. They do not cap existing
Grant Factory drafting, scoring, assistants, FinCap or direct use of the API key.

## Target and request bounds

The planner accepts 1–10 explicit targets, each with an ID, one question, HTTPS
source URL and supplied source text. Allowed purposes are `promising_grant`,
`eligibility`, and `difficult_document`. Difficult documents must first be
extracted locally. The URL is evidence metadata; the planner does not fetch it.
Broad paid discovery is not restored.

Model: `claude-haiku-4-5-20251001`; at most 2,000 output tokens and 32,000 UTF-8
source bytes per target. Questions/URLs are bounded. Tools, cache directives,
images, thinking, batch calls, model switching and caller-supplied API options
are excluded. The standard-only request fixes the pricing tier.

Reserve a full 200,000 input tokens and 2,000 output tokens at twice the reviewed
$1/$5 per million standard prices: **$0.42 per attempt**, $4.20 for ten targets.
Actual standard usage is calculated at the reviewed prices; unsupported billing
dimensions fail closed. Pricing/model availability must be reconfirmed in rollout.
The result is a proposal requiring human review, never automatic publication.

## Commands and reviewed input

```sh
pnpm research:dry-run tests/fixtures/research-budget-targets.json
pnpm test:research-budget
pnpm test
pnpm test:research-postgres
pnpm build
pnpm check:functions
```

The synthetic dry run performs zero DB/API operations and includes hashes,
identifiers and reservation amounts, excluding source text. Keep real targets
private. Review the actual source excerpts/questions alongside the hashes.

After rollout approval, the operator can use:

```sh
pnpm research:execute --execute private-reviewed-job.json
```

The private job has this shape:

```json
{
  "items": [{"id":"selected-grant","purpose":"eligibility","question":"The reviewed question","sourceUrl":"https://example.org/grant","sourceText":"Reviewed source excerpt"}],
  "targetId":"selected-grant",
  "review":{"cycleId":"verified-credit-cycle-id","planHash":"hash from dry run","reference":"approved review reference"},
  "attemptId":"unique-review-attempt"
}
```

It executes **one** selected target. The full items list must match the approved
dry-run hash. The CLI does not configure flags, create a cycle, approve a plan,
read billing, generate a key, release reservations or schedule work.
Do not run it against production before the reviewed activation.

## Database and isolated validation

`docs/research-budget-ledger.sql` is not a deployed migration. It defines a private
schema with RLS and service-role-only invoker functions. Thin public invoker RPC
wrappers use the existing Supabase REST/server configuration; the private schema
is not exposed. No new DB credential or direct production PostgreSQL access is
required. Final proposals remain private.

The normal Node suite uses PGlite. The additional CI command creates its own
PostgreSQL 17 container using the local Docker socket, with network=none, no
published ports, no host volumes, and a temporary in-memory data directory.
Independent `psql` processes verify distinct backend PIDs and observable lock
waits. Cases cover pending-request exclusion, $10/$85 races, backend termination
before commit, expiry after waiting, an eight-client burst, retries/stale balance/
failed reconciliation, and public RPC privileges/evidence persistence.
The container is removed after the test. It never accepts a database URL or
production configuration and makes no provider calls.

The command is intentionally limited to Linux GitHub Actions. The selected local
executor still fails during setup. Local checkout guidance/memories/uncommitted
work remain uninspected; changes are isolated on this draft's remote branch.
Remote main has no tracked AGENTS.md/.agents instructions.

There are no configured lint or TypeScript-check scripts. Node tests parse the
CommonJS files; aggregate tests, build and all 18 function bundles remain required.

## Production evidence from the initial inspection

On October 8, Netlify reported production deployment
`6ac3bbc01d650e0007c6cbf4` ready at PR46 merge commit
`af6986f824042d9838adfa6a90847047b38c354a`, published October 5.
The code defaults routine discovery to deterministic harvesting, removes daily
whole-corpus reconciliation and caps normal invocations at 20 jobs.
Twenty jobs is not a dollar cap.

One successful scoped DB query found the engine/Florida discovery and monitoring
enabled; daily counters were 200 pages, zero queries, $0 reserved AI spend.
Five latest scan samples were deterministic with zero input/output tokens and
zero estimated AI cost. These are samples, not proof that every feature is free.
The Functions environment flag was not retrieved directly. An initial read used
the wrong timestamp column and failed without writes; the corrected query used
the actual schema. No additional production DB reads are needed for these tests.

## Remaining review and activation

1. Review this final code and CI evidence. Resolve local guidance/concurrent
   checkout checks when the local executor is available.
2. Review a private set of real targets and its dry run. Confirm the existing
   provider key is bound to the intended organization **without revealing it**.
   Verify current promotional balance, the exact credit-cycle boundaries and
   expiry, and pinned-model prices. Record the balance verification time.
3. Approve the additive budget schema/RPC rollout and disabled code deployment.
   Generate the migration through the normal Supabase workflow; do not directly
   apply this document without review. Use the existing service configuration.
4. Approve the exact initial trial and acknowledge that some/all of its capped
   usage may draw purchased credit. Auto-reload cash purchases are separately
   controlled by billing and may exceed the amount of this API usage.
5. Record the reviewed cycle/plan, retain the $10 stage, and deliberately set both
   deployment flags. Invoke one target, inspect its proposal and persisted usage,
   then consider the remaining approved targets. Stop on any uncertainty.
6. Evaluate useful verified findings per dollar before expanding. A separate
   expansion review can raise the stage toward $85 within the same verified cycle.
   A new cycle requires new verified evidence; no automatic recurring activation.

See [practical controls and risk choices](research-budget-options.md).
