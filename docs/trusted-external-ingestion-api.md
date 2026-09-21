# Trusted External Ingestion API

Lets an authenticated external research system (ChatGPT, Claude, an internal
agent, a future crawler) submit funding-source candidates directly into
Source Intelligence, without a human pasting rows into the admin screen.

Every record goes through the exact same pipeline as a manual paste import:
the same normalization, duplicate detection, quality scoring, and
verification queueing. This API adds no new business logic of its own -- it
is a second front door onto the pipeline that already exists.

## Getting a credential

Credentials are issued in the app: **Source Intelligence → API credentials**.
An administrator creates one with a name, a system (ChatGPT, Claude, the
Opportunity Assist discovery agent, or Other), and three limits (max sources
per batch, max sources per day, requests per minute). The token is shown
once, at creation, and is never retrievable again -- only its hash is
stored. If a token is lost, revoke it and issue a new one.

Every request must include it:

```
Authorization: Bearer oa_live_...
```

A credential can be `active`, `disabled`, or `revoked`. Only `active`
credentials authenticate.

## Base URL

```
https://opportunity-assist-mtp.netlify.app/.netlify/functions
```

## POST /source-intelligence-import

Submits one batch of sources.

### Request body

```jsonc
{
  "source_system": "CHATGPT",        // required
  "mode": "QUEUE",                    // "DRY_RUN" or "QUEUE" (default "QUEUE")
  "state": "FL",                      // required, two-letter state code
  "batch_name": "Weekly sweep",       // optional, QUEUE mode only
  "submitted_by": "researcher@...",   // optional, QUEUE mode only
  "idempotency_key": "run-2026-09-17",// optional, QUEUE mode only
  "sources": [
    {
      "source_name": "Example Community Foundation Grant",
      "url": "https://example.org/grants",
      "source_type": "COMMUNITY_FOUNDATION_GRANT",
      "geography": "Florida",
      "keywords": "youth, education"
    }
  ]
}
```

`sources` may instead be a `text` field of pipe-delimited rows, identical to
the admin paste box:

```
"text": "Source name|https://example.org/grants|COMMUNITY_FOUNDATION_GRANT|Florida|youth, education\n..."
```

Only `source_name` and `url` are required per source. `source_type`,
`geography`, and `keywords` are optional strings (`geography` and
`keywords` accept either a plain string or an array; arrays are joined).
`source_type` is not validated against the enum at ingestion time --
unrecognized values pass through and can be corrected during review.

### mode: DRY_RUN

Analyzes the batch against the live registry and returns immediately.
Nothing is written -- no batch row, no candidates. Every request is first
checked against the credential's own max-sources-per-batch limit (see
below, default 500), then against a hardcoded 1,000-source ceiling for
`DRY_RUN` specifically -- whichever is lower applies. Use `QUEUE` for
larger batches. `DRY_RUN` still counts against the credential's rate limit
and daily quota.

```jsonc
// 200 OK
{
  "mode": "DRY_RUN",
  "submitted_count": 1,
  "new_candidate_count": 1,
  "exact_duplicate_count": 0,
  "possible_duplicate_count": 0,
  "invalid_count": 0,
  "results": [
    {
      "line": 1,
      "source_name": "Example Community Foundation Grant",
      "status": "new_candidate",       // "new_candidate" | "duplicate" | "possible_duplicate" | "invalid"
      // "existing_source_id" is present only when status is "duplicate" or "possible_duplicate"
      "match_reason": "No materially equivalent record found in complete registry",
      "quality_ready": false
    }
  ]
}
```

A row with `"status": "invalid"` carries an `error` string instead of the
other fields (for example `"url is required"`) and does not stop the rest
of the batch from being analyzed.

### mode: QUEUE

Saves and deduplicates the batch, then chunks it into background jobs (500
sources per chunk) for the existing verification pipeline. Returns a
`batch_id` immediately; poll it with the status endpoint below. Capped at
5,000 sources per request.

```jsonc
// 202 Accepted
{
  "batch_id": "b3f1...-...",
  "idempotent_replay": false,
  "status": "RECEIVED",
  "submitted_count": 1,
  "processed_count": 0,
  "new_candidate_count": 0,
  "exact_duplicate_count": 0,
  "possible_duplicate_count": 0,
  "invalid_count": 0,
  "verification_queued_count": 0,
  "needs_review_count": 0
}
```

If `idempotency_key` is supplied and a batch with that key already exists
for this credential, the existing batch is returned unchanged with
`"idempotent_replay": true` instead of reprocessing the submission -- safe
to retry a request after a network failure without double-importing.

Verification for an import submitted through this API is deliberately
uncapped and prioritized ahead of the system's own ongoing discovery and
monitoring: it does not draw against, or get paused by, the daily
per-state budget that governs organic work, and its VALIDATE jobs are
worked off before the system's own never-ending discovery/monitoring
queue gets a turn. The one exception is when the engine or the state
itself is disabled entirely (not a budget condition) -- that still applies
to everything, imports included.

### mode: TRUSTED_AUTOMATION

Reserved for a future, administrator-controlled mode with a different trust
model. Not implemented; the endpoint rejects it with `400`.

## GET /source-intelligence-batch-status

Polls a batch created by `QUEUE` mode. A credential can only read batches it
submitted itself.

```
GET /source-intelligence-batch-status?batch_id=<uuid>
Authorization: Bearer oa_live_...
```

```jsonc
// 200 OK
{
  "batch_id": "b3f1...-...",
  "batch_name": "Weekly sweep",
  "source_system": "CHATGPT",
  "status": "VERIFICATION_QUEUED",
  "submitted_count": 1,
  "processed_count": 1,
  "new_candidate_count": 1,
  "exact_duplicate_count": 0,
  "possible_duplicate_count": 0,
  "invalid_count": 0,
  "verification_queued_count": 1,
  "needs_review_count": 0,
  "errors": [],
  "created_at": "2026-09-17T21:00:00.000Z",
  "completed_at": null
}
```

`status` moves from `RECEIVED` to either `VERIFICATION_QUEUED` (all chunks
processed, no invalid rows) or `PARTIALLY_COMPLETED` (all chunks processed,
some rows were invalid) once every chunk has run. `completed_at` is set at
that point. A batch does not track further than this -- verification and
automatic approval continue in the background exactly as they would for a
manually pasted import, visible in the app's Discovery runs and Decision
history, not through this endpoint.

## Rate limits and quotas

Each credential has its own limits, set when it's created:

| Limit | Applies to | Default |
|---|---|---|
| Max sources per batch | one request | 500 |
| Max sources per day | rolling 24 hours, all modes combined | 2,000 |
| Requests per minute | all modes combined | 30 |

Exceeding the per-minute limit or the daily source quota returns `429`.
`DRY_RUN` calls count toward both, so a credential can't be used to run
unlimited free analysis.

## Errors

All errors return `{"error": "<message>"}` with one of these statuses:

| Status | Meaning |
|---|---|
| 400 | Malformed request -- missing/invalid field, unknown mode, batch too large for the limit or the endpoint's own cap |
| 401 | Missing or unrecognized bearer token |
| 403 | Credential is `disabled` or `revoked`, or lacks the required permission |
| 404 | Batch not found (wrong ID, or it belongs to a different credential) |
| 405 | Wrong HTTP method |
| 413 | Request body over 5 MB |
| 429 | Rate limit or daily quota exceeded |

## Example

```bash
# Analyze without writing anything
curl -X POST https://opportunity-assist-mtp.netlify.app/.netlify/functions/source-intelligence-import \
  -H "Authorization: Bearer oa_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "DRY_RUN",
    "state": "FL",
    "source_system": "CHATGPT",
    "sources": [{"source_name": "Example Grant", "url": "https://example.org/grant"}]
  }'

# Queue it for real
curl -X POST https://opportunity-assist-mtp.netlify.app/.netlify/functions/source-intelligence-import \
  -H "Authorization: Bearer oa_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "QUEUE",
    "state": "FL",
    "source_system": "CHATGPT",
    "batch_name": "Weekly sweep",
    "sources": [{"source_name": "Example Grant", "url": "https://example.org/grant"}]
  }'

# Poll it
curl "https://opportunity-assist-mtp.netlify.app/.netlify/functions/source-intelligence-batch-status?batch_id=<uuid>" \
  -H "Authorization: Bearer oa_live_..."
```

## What this API does not do

- It does not bypass duplicate detection, quality scoring, or verification.
  A submitted source becomes visible in the registry only after the same
  checks a human-pasted one would go through.
- It does not publish anything to Radar directly. Publication still
  requires verified evidence and, unless automatic approval is enabled, a
  human decision in the admin screen.
- It has no endpoint to manage credentials. Credentials are created and
  revoked only in the app, by an administrator.
