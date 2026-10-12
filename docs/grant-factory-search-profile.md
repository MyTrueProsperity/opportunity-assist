# Reviewed facts → grant search

Grant Factory keeps approved organization evidence separately from the Organization search profile. This change adds an explicit, reviewed transfer; approving an upload does not silently overwrite the profile.

## Using it

1. Upload the source document, choose **Read & suggest facts**, and review the suggestions against their sources.
2. An executive opens **Truth Review** or **Organization Brain → Review search profile**. The account must also be a member of that same Organization.
3. Select the approved, public facts/programs to transfer. **Append** preserves existing text and keywords. **Replace** applies only to selected fields and requires reviewing their complete replacement.
4. Preview the exact current/after values, then choose **Approve these public profile changes**. Source IDs, revisions, fingerprints and locators are retained in organization-scoped edit history. Changed facts or concurrent profile edits require a fresh preview.
5. Use **Find matching foundations** in Grant Factory, or **Foundation Leads → Find sources matching our profile — free**. This ranks a bounded selection of saved, approved foundation sources using Programs/purpose, Target populations, Keywords and Service areas. It does not search the web or establish eligibility.
6. Administrators may select a profile service state and choose **Collect from matching sources — free**. The existing manual discovery action queues up to three matched, approved starting URLs. The existing harvester can read those sources and their bounded related links, staging new findings for review. Engine/state/category gates and the existing daily page budget still apply. This does not enable a disabled engine, activate paid research, run automatically after transfer or publish new candidates.

## Selection and privacy

- Only organization-wide APPROVED/VERIFIED, public, externally permitted facts are offered. Private/restricted/internal, projected, derived, expired, conflicted, application-only and research facts are excluded. A linked source document must itself be approved for external use, public, readable and current. Original document blocks are never copied or sent to search services.
- Eligible programs retain their status: a planned program is explicitly labeled as planning. Legacy executive-approved programs without a sensitivity label are eligible only when both grant and external use were already allowed and no privacy/review flags exist.
- Only the five existing profile fields are transferable: Service areas, Target populations, Programs/purpose, Past performance/outcomes and Keywords. Names, government identifiers, contact details, credentials and financial records are excluded from suggested mappings. New keyword topics are bounded and screened for identifiers/contact information; existing manual keyword lists remain intact, including larger lists and legitimate financial-literacy/K–12 topics.
- The profile is a reviewed snapshot, not a continuously synchronized copy. Changing source permissions later does not silently remove the Organization's separately approved profile text. Review/remove that profile text too when withdrawing a public statement. Collection rechecks the current profile, organization membership and current source approvals before fetching.
- Foundation topics use a small public vocabulary; private outcome figures and full profile prose do not become external queries. Topic/state lookup is local to stored public source metadata. Investigation state alone never establishes applicant geography; sources without evidenced geography remain marked for review and are excluded as collection starting URLs.
- No new provider calls, credentials, billing authorization, recurring jobs or research activation. Existing $85-cycle maximum and credit/budget gates are unchanged. The existing daily 200-page limit is unchanged. Saving a transfer invalidates stale scores without automatically requesting paid scoring.

## Young Futures inspiration

Bill's [shared Young Futures questions](https://chatgpt.com/share/6ac84f46-e720-83ea-be0a-12e899761c14) emphasize leading with documented outcomes, taking appropriate ownership of proven results, matching the funder's actual purpose, preserving flexibility in program delivery, and connecting budgets, partnerships and measures to the proposed solution. Those principles inform the field mappings: mission/program purpose and people served guide discovery; proven outcomes support the writing case. A grant's instructions, present eligibility, past grantmaking and current application still require the existing Grant Factory evidence/review workflow. A matching topic is a lead, not proof of fit or an award promise.

## Database prerequisite and rollout

The atomic transfer RPC is versioned in [20261012025458_organization_search_profile.sql](../supabase/migrations/20261012025458_organization_search_profile.sql), generated with Supabase CLI 2.120.0. It updates the existing Organization row and writes provenance to existing `gf_history` in one transaction, using workspace/profile locks and optimistic comparisons. It is SECURITY INVOKER and executable only by the existing server service role; it additionally requires GF executive + OA organization membership. It does not expand browser permissions or alter existing RLS policies.

Install that migration before publishing the application code. It replaces the original review proposal and requests a Data API schema-cache refresh. The transfer tests load the exact migration, including its role permissions and idempotent function definition. If code runs before the RPC is installed, transfer returns a clear setup-needed error with no profile writes. Cached matching and manual collection use existing schema.

Production verification should check the function's role permissions and run an empty-patch transfer under the server role using an existing executive's current snapshot. This verifies the save path without changing organization facts or history. Compare source-engine/state settings and research-cycle counts before and after rollout. Do not start research, collection jobs or fact transfers as a deployment check.

## Limits

The shortlist inspects at most 400 recently verified approved foundation records and shows up to 20 matches. It reports that limit; it does not claim exhaustive discovery. The initial vocabulary covers common program/population themes and can be extended with tests. There is no general paid web-search integration, automatic grant qualification or automatic access to application portals. Foundation Leads' free shortlist currently requires the account's provisioned Grant Factory access as well as Organization membership.
