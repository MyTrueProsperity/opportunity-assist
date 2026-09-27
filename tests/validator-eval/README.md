# Strategy validation corpus and harness

Evaluation tooling for the strategy validator (`netlify/lib/grant-factory/strategy-quantities.js`, `strategy-attribution.js`, `strategy-evidence.js`). Nothing in this directory runs in production; the candidate fork under `candidate/` is loaded only by the harness.

## What is here

| File | Purpose |
|---|---|
| `harness.js` | Runs a validator against a labeled corpus and reports TP/FP/TN/FN, precision, recall, F1, failures by category, whether each safety-critical kind was caught, and whole-generation outcomes. `node tests/validator-eval/harness.js --validator=both <corpus...>` |
| `ablation.js` | Same, for every switchable variant of the candidate, one summary line each. Segmentation, citation ownership and the calculation guard were ablated this way before they became production in Step 1; that table is in the Step 0 report. |
| `segment.js` | Splits a section into corpus segments. Fixed at the Step 0 (PR #36) sentence splitting so segment ids stay stable; the validator applies its own segmentation to each segment it is given. |
| `build-corpus.js` | Turns a fixture of whole generations into a corpus: segments every section, proposes labels from surface features and the production validator's own flags, and applies hand adjudications from a labels file. |
| `validators/current.js` | Adapter over the production validator, unchanged. |
| `validators/candidate.js` | Adapter over the evaluation-only fork in `candidate/`; `make(options)` switches each proposed change on or off. |
| `candidate/` | Forks of the two production modules with the proposed support-scorer change marked `CANDIDATE` (the only difference from production since Step 1). When the production modules change, regenerate the forks from them and keep the `CANDIDATE` blocks. |
| `public-cases.js` | The public corpus: sanitized, structurally equivalent versions of every production true and false positive from PRs #29 to #36, plus synthetic cases for each safety-critical kind. Fictional organization, figures, ids and sources. |
| `private/` (git-ignored) | The private corpus with the real Institute wording: `institute-fixture.json` (facts, selected research records, library index, seven whole generations), `institute-labels.json` (hand adjudications), `institute-corpus.json` (built). Never commit. |

## Labels

Each segment carries one or more labels and an expectation `{ reject, kinds }`:

- `attribution_cited_correct`, `attribution_uncited`, `attribution_wrong_citation`
- `research_quantity_supported`, `research_quantity_unsupported`
- `applicant_quantity_supported`, `applicant_quantity_unsupported`
- `organization_fact`, `application_fact`, `plan_recommendation`, `gap_negative`, `instruction_question`, `denied_outcome`
- `known_false_positive` (a production or test false positive; expected to pass)
- `research_mention_uncited` (auto label: research vocabulary with no citation and no flag; expected to pass unless adjudicated)

Rejection kinds, as the harness derives them from validator reasons: `unselected_record`, `misattributed_number`, `uncited_number`, `denied_outcome`, `wrong_record` (the five safety-critical kinds), `uncited_attribution`, `unsupported_applicant`.

`confidence` is `firm` or `borderline`; the harness reports metrics for all segments and for firm labels only. Borderline cases are policy judgment calls (an instruction that repeats a cited figure without its id, a summary sentence that refers to the cited sentence before it, a correct citation under a wrong label).

## Rebuilding the private corpus

```
node tests/validator-eval/build-corpus.js tests/validator-eval/private/institute-fixture.json tests/validator-eval/private/institute-labels.json tests/validator-eval/private/institute-corpus.json --draft /tmp/draft.txt
node tests/validator-eval/harness.js --validator=both tests/validator-eval/private/institute-corpus.json
```

The fixture holds the organization facts, the 24 selected research records and the library index exactly as strategy received them, so the harness reproduces production rejections byte for byte.

## Guard test

`tests/validator-eval.test.js` runs the production validator against the public corpus on every test run and fails if a safety-critical case it catches today stops being caught, or if its false-positive or false-negative count grows. Change the baseline in that file only as a deliberate, reviewed decision.
