# Organizations and opportunity matching

## Organization switching

A person can belong to more than one organization and switch between them without a second login.

- `org_memberships (org_id, user_id, role)` is the explicit authorization list. Signed-in users can read only their own rows and cannot write any. Rows are created by the onboarding claim (below) or by service-role SQL, which is how an administrator grants access to an existing organization.
- `profiles.org_id` remains the **active** organization. Every existing policy built on `current_org_id()` (fit scores, pipeline, requirements, contracts, alerts, pursue decisions, activity, organization profile, subscription) keeps scoping reads and writes to exactly one organization at a time. Switching does not widen any policy.
- The `profiles_guard_active_org` trigger allows `org_id` to change only to an organization the user is a member of. The one exception: a user may claim an organization they created within the last day that has no members yet, which is how the onboarding and guest flows work, and which records them as `OWNER`. This also closes an older gap where `profiles_update_own` allowed setting `org_id` to any organization id.
- `my_organizations()` lists the caller's organizations for the switcher, and `set_active_org(p_org)` switches (RLS plus the trigger enforce authorization).
- The app shows the active organization in the sidebar and a switcher when the user has more than one. Switching clears all state loaded for the previous organization and reloads.
- `score-opportunities` scores the active organization and also requires a membership row for it.
- Grant Factory keeps its own `gf_members` roles. It opens in the active organization when the user is a Grant Factory member there, otherwise in a workspace they are a member of; it never opens an organization without a `gf_members` row.

Migrations: `supabase/opportunity-assist/`. Organization-specific grants (for example, a user's access to a particular organization) are data changes made with service-role SQL and are not stored in this repository.

## Matching

Shared logic lives in `assets/matching.js` (used by the browser and by `netlify/functions/score-opportunities.js`).

1. **Eligibility screen** (`eligibility()`), run before any paid scoring. An opportunity is `INELIGIBLE` only for a known barrier: a passed deadline, an inactive source, a named geography with no state in the organization's service area, or a single-source competition. Missing deadline, geography or requirements makes it `UNKNOWN`, not ineligible. Ineligible opportunities are recorded with reasons and never sent to the model, and the radar hides them by default.
2. **Rubric**. The model rates ten defined factors (organizational, programmatic and population fit, geography, applicant eligibility, capacity, funding fit, timing, past performance, risk) as `MATCH`, `PARTIAL`, `MISMATCH` or `UNKNOWN`, with a one-sentence reason. It does not supply an overall score.
3. **Headline** (`computeHeadline()`): the weighted average of the known factors. Unknown factors are left out instead of counted as zero; `confidence` is the share of rubric weight that was known. A factor the opportunity states is required but is unknown for the organization caps the score at 74. A known geography or eligibility mismatch caps it at 25. Recommendation: Strongly pursue (75 or higher with confidence of at least 0.6), Worth reviewing (55 or higher), Probably pass, or Needs more information (confidence below 0.5).
4. **Strong matches** count only current-rubric AI scores that are eligible and confident. Local keyword estimates are labeled "Estimate" and never count.

## Score freshness

`fit_scores.source_stale` is set automatically by triggers when an organization's scoring fields (name, programs, service areas, NAICS, UEI, SAM, certifications, past performance, target populations, keywords) or an opportunity's scoring fields (title, summary, requirements, geography, deadline, category, amount, source active) change. The app never shows a stale score or a score from another `rubric_version` as current; it requests a new one. Deadlines that pass are re-screened on every load.
