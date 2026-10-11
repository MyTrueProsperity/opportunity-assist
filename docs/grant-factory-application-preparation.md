# Grant Factory: prepare a complete, persuasive application

From **Capture Pipeline**, open an opportunity in **Qualified** or **Planning** and choose **Open in Grant Factory**. You can also use **Grant Factory → Import from Qualified or Planning**. The organization you are working in carries across. Reimporting the same pipeline item opens its existing application.

## Read and reconcile the actual application

OA saves the original public application in the private Document Vault. If the complete application is behind a login, upload it or paste the full question list and instructions. Add supplemental RFP, rubric and portal requirements through Application details. A narrative worksheet may omit fields, conditions or commitments. Captured text and reconciled requirements are separate from final readiness.

Use **Source checklist → Preview source repairs** to compare supplied sources without an AI call. Review added fields, changed types/choices/limits and requirements no longer found. Matched questions keep their IDs and saved answers. Missing fields and requirements stay visible by default; explicitly archive them only after comparison with the complete original. Previous answers, requirements and source documents remain in history. Ambiguous matches need corrected field labels and a fresh preview. **AI extraction preview** is optional and uses the existing allowance.

Confirm all checklist categories against the original: fields, conditional triggers, types and choices, limits, eligibility, deadlines/cycle, criteria and attachments. Conflicting sources, stale cycles, incomplete text and missing portal requirements require explicit resolution. Updating the project or request does not require repeating an unchanged source checklist, but changed requirements do.

## Make the strongest supported case

**Prepare first draft** proposes a program and prepares supported answers with saved writing guidance and the original funder requirements. It does not automatically apply source repairs. Save manual edits first; resume preserves saved text. Each answer is saved separately. Missing facts and institutional decisions go to **Needs My Input** alongside useful partial drafts.

## Writing guidance and substantive review

Grant Factory selects reviewed research by maintained topic, question purpose, application stage, authority and funder/program/cycle applicability. A title alone does not make a record a guide. Only active packages assigned to the workspace and verified canonical records are eligible. General methods, scoped funder guidance, editorial templates and research findings remain distinct. Historical AI policies do not become current universal rules. Held/conflicted records remain held; the balanced GW-066/067/068 research group is supplied together or omitted with an explicit limitation.

Each preparation request receives at most eight guidance groups, 18,000 characters of canonical passages and one authorized section lookup supplying at most 6,000 additional compilation characters. Summaries, excerpts, exact identities/locators, source limits and truncation are labeled. An unavailable section lookup leaves an explicit summary-only limitation; it does not trigger browsing, paid research or another model call. The full volume is never silently claimed to have been read for a draft.

Existing writing, strategy and audit calls propose **Applied**, **Not applicable** or **Needs input** assessments with actionable reasons. Selecting a guide is not proof of application. An applied assessment needs an exact answer passage and human review; broader substantive judgment remains the reviewer’s responsibility. Open **How writing research was applied** beside an answer, or **Review how guides shaped the strategy**. Saved edits retain the original trace and make its review stale after material changes. Strategy and claim audit retain separate traces. These traces are internal; clean funder exports contain the application answers and approved attachments.

## Governing AI conditions

Before generation, use **AI conditions** to review the complete governing source for this funder, program, cycle and stage. Record the original document, exact quote/locator, policy date when stated, date checked and responsible human. A public URL is optional for an uploaded original; a supplied URL must be valid. Record preparation, editing and substantive-generation permissions separately, together with disclosure format, confidentiality, prohibited data, reviewer conditions and unresolved questions.

**Unknown** or a missing/stale review blocks generation. **Not stated** means a human checked the complete source and found no rule; it is not affirmative permission. Known applicable prohibitions cannot be bypassed by changing models or tools or adding a human signature. Source/program/cycle/stage changes require a fresh review. Required disclosure must be located in an actual answer or reviewed exported attachment before final approval. A disclosure attachment must contain the exact declared text and remain at the reviewed source version.

Ordinary edits preserve AI authorship. To replace AI text with genuinely new human work, save the new response, check **complete new human-authored replacement**, and record how it was composed independently. Prior authorship/text hashes remain in internal history. This is an accountable human declaration, not automatic proof of authorship. Human answers can still be audited when the actual preparation/editing conditions permit it.

## Evaluation and delivery finance

**Project & budget** now records outputs versus outcomes, historical/current/planned results, baseline and target status, unavailable/not-applicable reasons, target rationale, instrument population/age suitability, collection burden, evaluator capacity and links to costed evaluation resources. Blank values remain unknown. An adult instrument does not automatically establish suitability for youth, and a logic model does not assign an evidence tier. No universal evaluation-budget percentage or WIOA measure is imposed.

Link each expense to delivery activities and an actual cost/quote source. Classify fixed/variable and one-time/recurring costs, confirm payment timing, and separate confirmed, planned and unsecured other funding. Only confirmed contributions reduce the funding gap. A nonzero confirmed contribution needs its source quote and locator. Review cash flow, contingency, sustainability and partial-award assumptions or give a non-applicable reason. Fixed costs cannot automatically shrink with a smaller award. Existing exact-decimal arithmetic, staffing/count/date reconciliation and original funder limits remain in force.

Private cost sources can support internal planning; their source text and dependent values are withheld from model inputs. Changed, missing or expired provenance needs review. Restricted cost rows stay executive-only, including in ordinary save/status responses; an editor cannot overwrite hidden rows. Entering a plan does not create an approved applicant fact, rate, institutional commitment or secured funding.

## Reviewer responses and application stages

Use **Reviewer responses** for inquiry, full application or resubmission requirements. Preserve receiving-funder invitation/contact rules and exact source provenance. Each comment records its exact text/source, criterion, issue type, owner, needed evidence/decision, response, resolution reason and exact revised answer/document location. Evidence, design, capacity, budget, fit and compliance concerns require substantive decisions, not merely a polished sentence. Changes to the source or revision make its resolution stale.

Confidential/internal funder comments can be used in the internal register. They are excluded from model inputs and clean funder exports; restricted comments require executive access. Later source privacy/version changes are rechecked before an AI request, and a register with restricted comments requires executive editing. Official decision quotes and funder-stated reasons are distinct from internal interpretations. Internal scores and recommendations are not awards or evidence of a funder’s motive.

## Audited source-to-code map

| Audit recommendation | Source coverage | Implementation |
| --- | --- | --- |
| Categorized relevant guidance and bounded passages | GW-013/023/024/025/034/045/075/076/077; balanced GW-066/067/068 and Part 4 §15; Part 6 editorial limits | `guidance-catalog.js`, `writing-guidance.js` |
| Persist and review guide application | Parts 1–3 proposal/review controls and Part 5 §13 | Writing/strategy/audit schemas, service traces, answer/strategy review UI |
| Application-specific AI conditions | Part 4 §12.5; Part 5 §12; historical scoped GW-017/018/042/043/072/097 | `ai-conditions.js`, source review UI, generation and final QA gates |
| Evaluation definitions and sizing | GW-023/076/077; Part 5 §§6–7/13.6–13.7; Part 6 §15 | Shared project model, measure/resource checks and form |
| Delivery-linked finance and sustainability | GW-034/045; Part 5 §13.5 and budget controls | Cost/activity links, cost/funding provenance, cash-flow/contingency/sustainability/partial-award checks |
| Reviewer-response register and stage revision | Part 2 §§11–12; Part 3 §12 | `reviewer-register.js`, source/stage/revision checks and internal UI |

The software can expose missing inputs and preserve decisions. Organizations must supply their actual baselines, feasible targets, age-appropriate measurement rationale, costs, cash timing, commitments and governing source interpretation. No production data is backfilled or approved by this change. Existing answers are preserved and new review needs appear before final readiness. No new database tables, migrations, providers, recurring jobs or automatic submissions are introduced.

The preparation questions reflect Bill’s Young Futures discussion: lead with the most relevant proven achievement; own documented results confidently; show why investments benefit participants; preserve flexible instructional schedules; distinguish operational capacity from funds committed to this solution; describe each partnership’s actual contribution and relationship stage; and link future targets to measurement. Use available space for substance. Historical results stay attributed to their delivering program and period, while new initiatives and expansions remain future work. Professional Academy’s planned opening is August 2027; it must not be described as already operating.

**Past awards & grantee fit → Research / add sources** accepts official award lists or reports. Analysis retains named recipients, disclosed amounts, funded work, exact quotations and similarities to approved applicant facts. A round total divided by awarded grants is a labeled round average, never an individual award. Past awards inform strategy; they do not establish eligibility, success odds or a recommended ask.

## Keep the whole project consistent

Use **Project & budget** for a shared scope, dates, current organization reach, current solution reach, projected unique reach, activities, staffing dependencies, costs, funding splits and evaluation. These entries are planning inputs, not evidence of achieved outcomes or authority to commit the organization. Unknown amounts remain unknown; zero means confirmed zero.

Cost the delivery before selecting an ask. Quantity × unit rate × duration × allocation produces each line cost using exact decimal arithmetic. Checks compare the request, confirmed other funding and remaining cost; award range/currency; grant-term dates and opening; staff hours; unique participants versus encounters; resource quantities; and outcome definitions. Identify confirmed funding sources and restrictions. Operating support can establish capacity without being counted as solution matching funds. Confirm funder timing and award constraints against an exact source quote; mark unpublished constraints **Not stated**, rather than guessing.

Eligibility is displayed separately as **PASS**, **FAIL** or **UNRESOLVED**. A strong strategic fit cannot override a hard failure. Source transcription corrections require an executive explanation and the original quote. Commitments and unresolved evidence need explicit human decisions. Material changes invalidate previous reviews while retaining the answers.

## Review and export

In **Whole proposal**, inspect all answers together against the supplied funder criteria, the shared model and authorized evidence. Resolve detected contradictions, repetition and attribution errors. An executive maps actual answers to each supplied criterion and records why they satisfy it. Where no rubric is supplied, the editorial checklist is clearly labeled; OA does not invent funder scores or probabilities. This deterministic review supplements the existing answer audits and human review. It is not a comprehensive automated semantic evaluation.

Review conditional applicability, attachments and every answer, then run **QA & human review** and final executive approval. Attachments need external-use permission and a current file/version/format check. A person must validate public-link access, video duration and rendered page counts. The vault currently accepts PDF, DOCX and text; unsupported media uploads still need manual portal handling. OA does not log into or submit to a grant portal.

**Funder package** includes the response document and approved attachments, with internal provenance and review notes excluded. It requires current approval and passing checks. The response DOCX can be exported for drafting when limits, layout and attachment checks permit. **Internal review package** and **Internal evidence JSON** are separate executive-only exports containing private review information; never send them to the funder. Package size is bounded; larger assets must be handled separately. Recorded submission snapshots and their originals remain preserved.

## Cost and access

This follow-up adds no AI task, paid provider, migration or scheduled research job. Checklist comparison, budget arithmetic and proposal coherence checks are deterministic. Optional parsing, existing strategy/history analysis, writing and claim audits use the workspace’s existing allowance. Public import is bounded to at most three pages per operation with a shared time limit. Saved writing research guides preparation; it does not train the model or establish applicant achievements. Development verification uses synthetic data and stubbed AI with external calls blocked. No production grant records are repaired automatically.
