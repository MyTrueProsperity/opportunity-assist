# Practical research spending controls

The approved objective is near-zero cost with an enforceable OA allowance.
A research dollar cap and a promotional-only guarantee are different controls.

## Least-invasive path: the OA guard

Use the existing key and existing server-side Supabase configuration through the
new operator-only path. The DB reserves worst-case cost before each request and
enforces the initial $10 stage and $85 verified-cycle ceiling. It subtracts a
$15 shared-use cushion from a recent promotional-balance snapshot and checks
expiry; it does not constrain FinCap or other applications.

This is a feasible OA usage cap without creating credentials or changing billing.
It is the recommended next trial path after review. Current production remains
disabled; no live credit-cycle settings exist yet.

Residual risk: other users/apps can consume the shared promotion after the
snapshot. In the worst funding case, **all newly approved research usage can
be purchased-credit usage: up to $10 for the trial, or up to the cumulative $85
after expansion**. Already-incurred amounts count toward those limits.
At this draft's reviewed prices, each attempt reserves $0.42; ten targets reserve
$4.20. These are conservative usage allocations, not promises about cash charges.

Auto-reload can purchase a configured bundle when its threshold is crossed.
That cash payment may exceed the research usage and fund unrelated later usage.
Its amount/threshold are not inspected or controlled here. The $85 research cap
does not cap all organization spending, auto-reload transactions, taxes or other
features. The $15 is OA's allocation/cushion; it is not an escrow guaranteeing
that other apps still have $15 if they spend beyond their allocation.

Permission needed: approve the reviewed code/schema deployment, verified cycle
and exact private dry-run plan, and explicit initial activation accepting this
bounded usage funding risk. This does not require a new subscription, a new key,
billing changes, other-app restrictions, or an Admin API credential.
Expansion past $10 remains a later separate review.

## Optional provider workspace backstop

Anthropic documents monthly workspace spend limits for non-default workspaces.
This can add protection against a bug or a code path bypassing the app ledger.
Use an existing dedicated research workspace/key if one is already available
and appropriately scoped; that fact has not been verified. Default Workspace
does not support its own limit. Limits on a shared workspace could restrict
FinCap or other features and must not be applied indiscriminately.
[Workspace limits](https://platform.claude.com/docs/en/manage-claude/workspaces)

A provider workspace limit follows the calendar-month accounting window; the
promotional credit follows its verified billing cycle. Therefore the app ledger
must remain authoritative for the credit-cycle cap. The provider limit can
unnecessarily constrain a cycle split across months, or reset mid-cycle.
It also does not earmark promotion or stop purchased-credit fallback.
[Provider spend-limit behavior](https://platform.claude.com/docs/en/api/rate-limits)

Permission needed: explicit approval to inspect non-secret workspace/key scope
metadata and configure a limit on an identified research-only workspace.
If it requires a new workspace/key or changing a deployed credential, obtain
specific approval first; do not generate one automatically. No changes were made.

## Organization-wide allocation gateway

For stronger shared-budget control, every API consumer could reserve through a
single budget service: research <=$85, other workloads <=$15, total <= verified
funds, with conservative reservations and expiry checks. That could protect an
allocation if every consumer participates and existing bypass keys are controlled.
Historical reporting alone cannot make a nonparticipating caller respect it.
This is an architecture option, not implemented or necessary for the initial trial.

Permission needed: changes to every relevant app and key-routing/access controls,
plus consent that FinCap/other requests can stop at their $15 allocation. Those
actions are outside the present authorization and are not proposed for automatic
execution. It is more invasive than the research-only guard.

## Billing controls are a separate decision

Disabling auto-reload alone would stop new automatic purchases, but API use could
still consume an existing purchased-credit balance. An organization-wide spend
limit could interrupt all apps and resets on the calendar month. Removing
purchased credit or preventing all fallback is not an established self-service
control in the documentation reviewed here. Do not treat any of these as
equivalent to isolating a promotional research wallet.

Permission needed: a separate, explicit billing/account decision including the
impact on other apps. None is required merely to test the OA guard. No Console
browser inspection was retried and no billing controls were changed.
[Promotional credit order, sharing and fallback](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)

The similarly named **Spend Limits API** concerns Claude Enterprise member
limits and is explicitly unavailable to Claude Platform/Console organizations.
It is not a reason to obtain an Admin API key or buy another plan.
[Spend Limits API scope](https://platform.claude.com/docs/en/manage-claude/spend-limits-api)

The Usage and Cost API supplies historical reporting and needs elevated
credentials. It can help audit costs but is neither a real-time promotional
wallet nor an atomic reservation mechanism. Do not broaden persistent access
just to obtain historical reports for this trial.
[Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)

## Exact next decision

Approve or decline a **reviewed, operator-run trial with at most $10 cumulative
OA research reservations**, using the existing account/configuration, a fresh
verified balance/cycle and $15 cushion, after the schema and code rollout review.
Acknowledge possible purchased-credit use and separate auto-reload cash payments.
Start with one target, inspect/reconcile it, and do not enable recurring jobs.
No approval to expand to $85, change billing, create credentials or alter FinCap
is implied by that decision.
