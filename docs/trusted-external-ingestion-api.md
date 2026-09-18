# Trusted External Ingestion API

Lets an authenticated external research system (ChatGPT, Claude, an internal
agent, a future crawler) submit funding-source candidates directly into
Source Intelligence, without a human pasting rows into the admin screen.

Every record goes through the exact same pipeline as a manual paste import:
the same normalization, duplicate detection, quality scoring, and
verification queueing. This API adds no new business logic of its own for
`DRY_RUN`/`QUEUE` -- it is a second front door onto the pipeline that
already exists. `TRUSTED_AUTOMATION` (below) adds exactly one new piece of
logic -- checking a submitter's own quoted evidence against the page text
that submitter supplied -- and reuses everything else unchanged.

## Getting a credential

Credentials are issued in the app: **Source Intelligence → API credentials**.
An administrator creates one with a name, a system (ChatGPT, Claude, the
Opportunity Assist discovery agent, or Other), and three limits (max sources
per batch, max sources per day, requests per minute). The token is shown
once, at creation, and is never retrievable again -- only its hash is
stored. If a token is lost, revoke it and issue a new one.

A credential can optionally also be granted the
`SOURCE_INTELLIGENCE_TRUSTED_AUTOMATION` permission, either at creation or
later from the credentials list, without reissuing its token. This is
required for `TRUSTED_AUTOMATION` mode (below) and is a separate,
deliberate grant -- an administrator should only extend it to a submitter
trusted to ground its claims honestly, since a fully-evidenced
`TRUSTED_AUTOMATION` submission skips the independent verification fetch
every other mode still gets.

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
  "mode": "QUEUE",                    // "DRY_RUN", "QUEUE", or "TRUSTED_AUTOMATION" (default "QUEUE")
  "state": "FL",                      // required, two-letter state code
  "batch_name": "Weekly sweep",       // optional, QUEUE/TRUSTED_AUTOMATION only
  "submitted_by": "researcher@...",   // optional, QUEUE/TRUSTED_AUTOMATION only
  "idempotency_key": "run-2026-09-17",// optional, QUEUE/TRUSTED_AUTOMATION only
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

This `sources` shape is for `DRY_RUN` and `QUEUE`. `TRUSTED_AUTOMATION`
uses a different, richer shape described in its own section below.

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

### mode: TRUSTED_AUTOMATION

Requires the credential to carry the `SOURCE_INTELLIGENCE_TRUSTED_AUTOMATION`
permission (see *Getting a credential* above); otherwise this returns `403`.

For a submitter that already read the page itself -- an AI research agent
browsing live, a human researcher -- and can supply its own extracted
evidence, instead of handing over a bare URL for this system to fetch and
extract on its own. `sources` takes a different shape from `DRY_RUN`/`QUEUE`:

```jsonc
{
  "sources": [
    {
      "source_url": "https://example.org/grants",
      "page_text": "Community Impact Grant. This is a competitive grant from the Example Foundation. Eligible Florida nonprofits can apply. Applications are now open. Awards up to $25,000.",
      "page_title": "Community Impact Grant | Example Foundation",   // optional
      "retrieved_at": "2026-09-18T12:00:00.000Z",                     // optional; "observed_at" also accepted
      "submitter_type": "CLAUDE",                                     // optional, free text
      "links": [{ "url": "https://example.org/apply", "text": "Apply" }], // optional; needed only if a program's application_url should validate
      "programs": [
        {
          "organization_name": { "value": "Example Foundation", "quote": "Example Foundation" },
          "program_name": { "value": "Community Impact Grant", "quote": "Community Impact Grant" },
          "funding_mechanism": { "value": "competitive grant", "quote": "This is a competitive grant" },
          "applicable_states": { "value": ["FL"], "quote": "Eligible Florida nonprofits can apply" },
          "current_cycle_open": { "value": true, "quote": "Applications are now open" },
          "award_max": { "value": 25000, "quote": "Awards up to $25,000" }
        }
      ]
    }
  ]
}
```

`source_url` and `page_text` are required per source (a submission with no
`page_text` is rejected as invalid -- use `QUEUE` instead for a bare lead
with no evidence). `page_text` is the rendered, readable text the submitter
actually reviewed, not raw HTML, and is capped at 40,000 characters, the
same evidentiary window this system's own fetcher works with. `programs` is
required and non-empty; up to 6 programs per `source_url` are accepted
(matching this system's own AI extraction limit) -- a 7th onward is
reported as its own invalid row rather than silently dropped.

Every field inside a `programs[]` entry is either omitted or
`{ "value": ..., "quote": "..." }` -- the exact shape this system's own AI
extraction already produces internally. The full set of recognized fields
is the same one that extraction can populate: `organization_name`,
`program_name`, `summary`, `purpose`, `eligibility`, `funding_mechanism`,
`funding_pool`, `administering_unit`, `geography`, `recurring_status`,
`application_status`, `application_url`, `current_status`,
`current_cycle_open`, `current_deadline`, `deadline_mentioned`,
`amount_mentioned`, `award_min`, `award_max`, `applicable_states`, plus the
unwrapped `source_type`, `authority`, `rejection_reason`, `keywords`, and
`applicant_types`.

Each claim's `quote` is checked locally against that source's `page_text`:
decoded of HTML entities, Unicode-normalized, non-breaking/typographic
spaces and repeated whitespace collapsed, case-insensitive -- but never
stemmed, paraphrased, or matched semantically. This proves the quote the
submitter claims to have read is genuinely present in the text they
supplied; it does not, and is not meant to, independently confirm the live
page still says the same thing. A claim whose quote doesn't ground is
simply dropped -- exactly like an unverifiable claim from this system's own
AI extraction -- rather than failing the whole row.

From there, every record goes through the identical duplicate detection,
quality scoring, and automatic-approval eligibility as any other import.
The only thing this mode changes is how a record becomes eligible for
automatic approval in the first place: a `TRUSTED_AUTOMATION` submission is
marked verified as soon as its `page_text` is processed (whether or not
every individual claim happened to ground), so a fully-evidenced submission
is never re-queued for this system's own independent fetch the way a
`QUEUE` submission still is.

The response shape is identical to `QUEUE`'s `202 Accepted` batch summary
below; poll it the same way.

`DRY_RUN` does not support the `TRUSTED_AUTOMATION` payload shape -- there
is currently no preview-only path for a trusted submission.

One known gap: `applicable_states` only grounds from an explicit state
name in a quote (as shown above). The county-based eligibility inference
this system's own extraction applies afterward (e.g. crediting Florida
eligibility from "Duval, Clay and Baker counties" without the word
"Florida" appearing) is not yet wired into this path, so a submission
relying only on county names for eligibility won't reach
`quality_ready` -- name the state explicitly in the eligibility quote for
now.

## GET /source-intelligence-batch-status

Polls a batch created by `QUEUE` or `TRUSTED_AUTOMATION` mode. A credential
can only read batches it submitted itself.

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

# TRUSTED_AUTOMATION: supply evidence already extracted from a page you read,
# instead of a bare URL for this system to fetch and extract itself. Requires
# the credential to carry SOURCE_INTELLIGENCE_TRUSTED_AUTOMATION.
curl -X POST https://opportunity-assist-mtp.netlify.app/.netlify/functions/source-intelligence-import \
  -H "Authorization: Bearer oa_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "TRUSTED_AUTOMATION",
    "state": "FL",
    "source_system": "CLAUDE",
    "sources": [{
      "source_url": "https://example.org/grants",
      "page_text": "Community Impact Grant. This is a competitive grant from the Example Foundation. Eligible Florida nonprofits can apply. Applications are now open. Awards up to $25,000.",
      "programs": [{
        "program_name": {"value": "Community Impact Grant", "quote": "Community Impact Grant"},
        "funding_mechanism": {"value": "competitive grant", "quote": "This is a competitive grant"},
        "applicable_states": {"value": ["FL"], "quote": "Eligible Florida nonprofits can apply"}
      }]
    }]
  }'
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
