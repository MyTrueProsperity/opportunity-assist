# Florida production pilot — September 9, 2026

Opportunity Assist Source Intelligence is deployed into the existing production app, Supabase project and Netlify functions. This report distinguishes the limited live pilot from automated acceptance tests and from statewide research coverage.

## Corpus reconciliation

The initial production reconciliation preserved 8,760 original rows: 3,391 from the audited GitHub snapshot, 4,377 from the concurrently maintained database watchlist, 108 historical Foundation Scan hits and 884 existing opportunities. It produced 4,582 unverified registry records before review. All watchlist and historical-hit inputs imported without errors. Sixteen old opportunity rows contained invalid source URLs; their complete original rows were retained as import exceptions. Of the 884 existing opportunities, 868 received source-program links.

The watchlist has 4,377 rows and a maximum ID of 4,887. The maximum ID is not a row count or confirmation that the other task finished loading every requested list. The watchlist remains a database input, and later additions can be reconciled without replacing the scanner file.

An additional official Florida Keys source was entered through the real five-column import and duplicate preview, adding one manual input row. It was recorded separately from the independent search results.

Repeat reconciliation `e85add3a-7651-418e-86ed-0344d6c11ec4` completed at 21:16 UTC. It processed all 8,760 original rows, created zero programs and retained the same 16 exceptions. The live totals remained 8,761 raw input rows, 4,583 programs after the distinct-track approval and 884 opportunities. Both the original-import reference fingerprint and the program identity fingerprint matched their pre-repeat checkpoints exactly. Most imported programs remain unverified; importing them does not imply source approval.

## Independent searches

Both statewide pilots used geography/category configuration to generate queries and invoked the actual provider web-search tool. The curated registry was used afterward to compare results, not to supply the searches.

| Measure | Initial pilot | Independent repeat |
|---|---:|---:|
| Run ID | `4f5af1ba-05e7-48c3-bb33-a020a5e536a2` | `0c54af35-c3d8-4265-a7ec-8fcebf6d097f` |
| Scope | Florida statewide / community foundations | Same scope; query order rotated |
| Actual web-search requests | 2 | 2 |
| Search result URLs retained | 12 | 12 |
| Page attempts, including retries | 15 | 12 |
| Pages fetched, before extraction | 13 | 11 |
| Unchanged pages reused | 0 | 7 |
| Extracted candidate observations | 38 | 37 |
| Possible-duplicate observations | 24 | 23 |
| Provisional new observations | 14 | 14 |
| Automatically published registry additions | 0 | 0 |
| Recorded result | Partial: historical extraction errors retained | Partial: Sarasota website timeout retained |
| Recorded estimated provider cost | $0.258451* | $0.119907 |

“Provisional new” is a matching outcome, not an approved source count. Many such observations were unsupported, out of state, or third-party listings and remained quarantined. Candidate counts include repeat observations and multiple mechanisms on a page; they are not unique funder counts. Neither pilot recorded automatic exact or semantic duplicate rejections. Ambiguous matches were reviewed, and approvals were deliberately narrow.

*The first pilot's recorded cost excludes one truncated response from before failed-response usage accounting was corrected. Its recorded cost is therefore a lower bound. Conservative daily reservations also cap work; they are not the provider bill.

The first pilot exposed PDF runtime packaging and multi-program response-limit problems. Both were corrected and retried successfully. The real PDF returned HTTP 200 and extracted text after the Linux native binary was explicitly included. The original failures remain in history. CI now unpacks the function archive outside the repository and reads a real PDF, preventing installed development dependencies from concealing an incomplete deployment.

The repeat completed every queued job: eleven source pages were read and the Sarasota request timed out. Source-access review does not relabel this run as completed or erase its timeout. Internal/provider errors and unfinished jobs remain hard rollout blockers.

## Review and benchmark checks

The release checks below were performed by the implementation agent against official source evidence using the authenticated Admin review workflow and its database transactions. They are recorded decisions, not an assertion that the owner separately reviewed every candidate.

| Source checked | Finding and action |
|---|---|
| [Brevard Competitive Grants](https://cfbrevard.org/grants/grant-guidelines-and-eligibility/) | Existing program confirmed and updated under its original ID. No open cycle was authorized. |
| [Collier grants hub](https://colliercf.org/nonprofits/apply-for-grants/) | Program Grants updated under the existing ID. Capacity Grants approved as one distinct program under the same foundation: organizational capacity, a smaller award range, a matching requirement and a budget limit distinguish it from service-program grants. A repeated candidate was merged into that one approved program. |
| [Florida Keys annual grants](https://cffk.org/for-nonprofits-center-for-nonprofit-excellence/grants/) | The first search found a third-party listing and missed the official page. The official source was imported separately, verified and used to update its existing program and opportunity. The open 2026 cycle retains the stated noon September 30 deadline and quoted typical award range. |
| [Tampa Bay annual grants](https://www.cftampabay.org/annual-competitive-grants) | Present in both searches. Existing-source match remained reviewable; the pilot did not approve an open cycle from it. |
| [Broward grants](https://www.cfbroward.org/receive/apply-for-grants) | Missed by both small statewide sweeps despite a valid official grant page and existing corpus coverage. This is a false-negative spot check and a reason to continue geographic/category sweeps. |
| [Quad Cities capacity grants](https://www.qccommunityfoundation.org/nonprofitcapacitybuilding) | The official eligibility area is outside Florida. The candidate failed Florida eligibility and was manually rejected for this state. |
| [Patterson capacity program](https://pattersonfamilyfoundation.org/grant/community-foundation-capacity-building-program/) | Official eligibility is limited to its Kansas/Western Missouri catchment. The Florida candidate was rejected. |
| [Northeast Florida grant hub](https://www.jaxcf.org/apply-for-grants-or-scholarships/) | Separate program, capacity and small-organization mechanisms were retained for review. A visual-art sponsorship classified as a grant was explicitly marked for investigation; no publication was authorized. Old cycle pages were not treated as proof of an open current cycle. |

The fundsforNGOs lead and its extracted third-party candidate were rejected as an aggregator source. Other unapproved observations remain available for investigation. This is not a claim that all remaining candidates are valid or that the entire legacy corpus has been reviewed.

Five official Florida benchmark pages were checked for missed sources: Brevard, Collier, Tampa Bay, Florida Keys and Broward. The initial sweep returned the official pages for three of those five; Florida Keys had only an indirect listing, and Broward was absent. This small, non-random sample is not a statewide recall estimate.

## Live integration and coverage limits

The Florida Keys approval created cycle `6b7bdc84-e876-4fe1-94a9-580e07bab26d` and updated existing opportunity `480b8154-6c3e-4b9d-86e0-cbaca29a36d2`, preserving its program and customer references. Numeric award fields that the latest extraction did not verify remain null; the source's award wording is retained. Unapproved registry records cannot publish.

The actual primary monitoring job in run `dd44aa2f-521b-4a5d-82dd-d154d5aea455` completed at 21:16 UTC with one unchanged page, one exact match, one opportunity update and zero model calls or estimated provider cost. There remained exactly one cycle for this program, linked to the same opportunity. Its next source check was scheduled for September 16. Three related-link checks were queued as normal follow-on work; this does not imply that every child page was inspected during release validation.

The matrix contains all 67 Florida counties plus statewide coverage across 18 categories (1,224 cells). This pilot tested one statewide category. A separate scheduled Duval search began during validation and was temporarily paused to keep the release checks bounded, then returned to the queue under the restored daily limits. A redundant pre-fix Duval job is retained as paused history and no longer blocks future scheduling. No county or category is labeled comprehensively searched by these small sweeps. Most coverage remains unsearched.

National rollout is controlled independently for each of the 50 states and DC. Discovery, monitoring and publication each have their own state switch, with per-state query, page, category and budget settings. Florida review unlocks the ability to enable another state; it never enables another state automatically.

The scoped operational review was saved at 21:21 UTC for the independent repeat, with six precision/duplicate spot checks, five missed-source checks and explicit acceptance of the Sarasota timeout. The run remains `PARTIAL`. Florida discovery, monitoring and approved-source publication are enabled across the 18 configured categories; every other state remains off. Normal limits were restored to $3/day globally and $1/day, four queries and 25 pages for Florida. Pilot reservations already exceed those restored daily limits, so additional paid work waits for the UTC reset. These are provider reservation limits, not invoices.

## Verification status

All 87 automated tests pass locally, including migrations, RLS/authorization, identity and aliases, review transactions, durable jobs, state gates, publication/cycle preservation, raw import references, unchanged-page caching and PDF reading. The static build and all 12 Netlify function packages pass. Linux CI additionally checks the packaged PDF runtime. All six additive migrations are installed in production, and the 17 source tables retain row-level security.

At the final operating-settings check, total recorded estimated provider cost across release runs was $0.462508, subject to the first-pilot accounting limitation above. Final deployment and CI references are recorded in the release status delivered alongside this report.
