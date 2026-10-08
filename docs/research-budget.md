# Bounded research: disabled pending promotional-credit isolation

## Release state

This proposal adds a dry-run planner, a fail-closed production entry point, an
offline funding protocol, and a PostgreSQL ledger proposal with automated tests.
It does **not** add a live provider adapter, HTTP endpoint, recurring job, migration,
credit-cycle record, API key, environment flag, or worker integration.
The production entry point always returns
`PROMOTIONAL_CREDIT_ISOLATION_UNAVAILABLE`. Setting an environment variable cannot
enable it. Routine deterministic collection and existing FinCap/product AI
features are independent and unchanged.

The code must remain disabled until a reviewed integration can actually prevent
purchased-credit use. A balance screenshot, recent usage report, reserved research
budget, or separate workspace with a spend limit is insufficient: other API keys
and workspaces draw from the same promotional pool. The provider would need to
atomically earmark promotion-only funds for the exact request and honor them
through final billing, including an in-flight request at credit expiry. No such
verified adapter is currently available to this implementation.

Official references checked during preparation:
- [Credit application, sharing, expiry and fallback](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers):
  credits refresh on the billing cycle, while ordinary spend caps reset on the
  calendar month; purchased credit can be used after promotional credit runs out.
- [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api):
  historical reporting and reconciliation, not an atomic funding reservation.
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing):
  the pinned Haiku 4.5 standard rate is $1 input / $5 output per million tokens.
  Prices and model availability must be reviewed again before a live integration.

Do not create credentials, broaden access, change billing/auto-reload, or disable
other applications to work around this blocker without separate authorization.

## Budget and request protocol

- Integer microdollars avoid floating-point cap comparisons. Initial stage:
  **$10**. Absolute ceiling: **$85 per verified promotional credit cycle**.
  Advancing beyond the trial requires another explicit review reference.
- The provider authority contract additionally reserves **$15 for other apps**
  against the shared promotional pool. The local ledger cannot guarantee that
  other apps will themselves stay within $15.
- The planner accepts 1–10 explicit targets, each with one question and supplied
  source text. Purposes: promising grant, eligibility, difficult document.
  Broad discovery, caller-supplied tools/options, images and remote document
  fetching are excluded. Difficult documents require locally extracted text.
- Model is pinned to `claude-haiku-4-5-20251001`; output is at most 2,000 tokens.
  At most 32,000 UTF-8 source bytes, plus bounded question/URL and fixed system
  prompt. Reserve the full 200,000-input-token allowance at twice the reviewed
  standard input/output rates: **$0.42 per attempt**; ten targets reserve $4.20.
  This intentionally overstates likely cost. No cache, tool, thinking, batch,
  priority-tier, model fallback or SDK retry charges are allowed.
- Review binds the complete dry-run plan hash. Any target/prompt change changes
  that hash. The database requires the exact cycle/plan to be approved.
- Reserve durably before contacting any billable service. The PostgreSQL ledger
  serializes admissions under a short mutex-row transaction. One outstanding
  request is allowed across cycles/processes. No network call holds a DB lock.
- Both caps count **all reservations permanently**, even when final measured
  usage is lower. Actual usage is also recorded. This deliberately spends less
  than the maximum and avoids unsafe refunds or stale reconciliation races.
- Duplicate attempt IDs and repeat request hashes cannot send again. No automatic
  retries. Timeout, crash, missing usage, unknown billable counters, over-limit
  usage, bad funding receipt or failed DB reconciliation retain the reservation.
  Pending/failed attempts block later workers. There is no expiry-based refund.
- Credit and price expiry are checked before admission and again immediately
  before dispatch, allowing 90 seconds plus a five-minute safety margin.
  This margin is additional defense; only the required provider authority could
  guarantee funding for requests completing after expiry.
- No automatic cycle reset, monthly cron, or inferred replenishment. Exact credit
  identity, start/end, deposited balance, prices and approvals must be verified.
  Overlapping enabled cycle IDs are denied rather than creating fresh headroom.

`protocol.js` is dependency-injected scaffolding exercised only with mocks.
`reservePromotionOnly`/`executeOnce`/`reconcile` describe a required future
provider guarantee; they are **not Anthropic API methods**. A boolean
`promotionOnly` supplied by a caller is not independent evidence. Do not expose
the protocol as an endpoint or wire a normal Anthropic key into this interface.
Production consumers must use `index.js`, which denies execution.

## Local dry run

```sh
pnpm research:dry-run tests/fixtures/research-budget-targets.json
pnpm test:research-budget
pnpm test
pnpm build
pnpm check:functions
```

The fixture is synthetic and yields no real grant finding. Dry-run output includes
target identifiers, prompt hashes, per-attempt/total reservation and the current
blocker; it excludes source text and performs zero DB/API calls. Store real target
files privately, outside tracked fixtures. Review source excerpts and questions
alongside the hashes, since hashes alone do not convey research quality.

This repository currently defines no lint or TypeScript-check scripts.
The Node test loader parses the new CommonJS modules, and the existing aggregate
suite/build/function-packaging workflow remains the required validation.
Test the final commit, not an earlier draft.

The SQL is intentionally `docs/research-budget-ledger.sql`, outside migrations.
Tests run it in local PGlite with test-only roles. It uses a private schema, RLS,
invoker functions, parameterized queries and service-role-only privileges.
PGlite's concurrent admission test exercises queued concurrent calls; it is not
a multi-connection production PostgreSQL load test. Real multi-session transaction
and deployment verification are required before any future live adapter rollout.

## Production evidence and limitations

Read-only inspection on 2026-10-08 found Netlify's current production deployment
`6ac3bbc01d650e0007c6cbf4` ready at PR46 merge commit
`af6986f824042d9838adfa6a90847047b38c354a` (published October 5).
That commit defaults routine Source Intelligence to deterministic collection,
removes daily corpus reconciliation, and caps the usual invocation at 20 jobs.
Twenty jobs is a throughput bound, not a dollar cap.

One consolidated successful database read found the engine and Florida discovery/
monitoring enabled; today's usage was 200 pages, zero queries and $0 reserved AI
spend. The five latest scan samples were deterministic with zero input/output
tokens and zero estimated AI cost. This is evidence of the free finder operating,
not proof that every API feature is free or a full audit of today's calls.
The Functions-scoped harvester flag was not read directly, to avoid retrieving
secrets through the broad environment-variable interface. No worker was invoked.
An initial read had a column-name error and performed no writes; the corrected
read used the actual schema. No corpus/table data was exported.

The selected command environment failed setup and file writing. Local checkout,
local AGENTS/skills/memory and uncommitted work could not be inspected. Remote
main's tree contains no tracked AGENTS.md or .agents instructions. Preparation
therefore uses a fresh isolated GitHub branch from the verified commit and never
writes to the active local coding checkout. Existing open PR15 and the active
local coding task were inspected as concurrency context.

## Review before any production rollout

1. Review this dormant code, tests and synthetic dry run. Confirm local project
   guidance and any uncommitted work once the command environment is repaired.
2. Resolve promotional-only funding through a supported, reviewed mechanism
   without changing access or billing implicitly. Reliable balance visibility
   alone cannot eliminate the shared-account race. If this remains unavailable,
   stop: production paid execution remains disabled.
3. Verify the actual promotional credit cycle and expiry, available shared
   balance, provider account binding and current pinned-model pricing. Do not
   assume calendar months or automatically replenish from an old screenshot.
4. Select a private, small set of promising grants, eligibility questions and
   difficult-document excerpts. Run the offline dry run and review its exact
   sources, questions, hashes and conservative reservation.
5. With separate deployment approval, generate/review a migration using the
   repository/Supabase workflow; verify privileges and multi-session lock behavior
   in an isolated database. Implement/test the real funding adapter, no hidden
   retries, authorization, approved-plan persistence and proposal-only result
   handling. No automatic publication or recurring schedule.
6. Only after the above evidence and deployment approval: manually run one
   reviewed target, reconcile its final usage and funding receipt, then consider
   the remaining reviewed batch within the cumulative $10 trial. Stop on any
   uncertain outcome. Report usefulness, unknowns and cost per useful finding.
7. Review trial value before considering expansion; retain the $85 verified-cycle
   ceiling and shared $15 reserve. A new credit cycle needs fresh verification
   and approval data, never a calendar reset.

No paid trial or production deployment is authorized by a passing unit test.
