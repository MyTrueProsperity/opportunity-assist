# Pass & Share with FinCap

A grant that is a poor fit for one organization can still help another financial capability practitioner. Pass & Share records the private Pass for the active organization and, in the same database transaction, offers a neutral listing to FinCap editors. Nothing is public until an administrator approves it.

## Flow

1. **Pass & Share with FinCap** (Dashboard decision row and Capture Pipeline review page) calls `fincap_pass_and_share`. One transaction records the private decision, removes the pipeline card when there is one (history re-homed, as in the review-page Pass), creates or joins the submission, records private attribution, and logs activity. A failure rolls everything back and the user is told nothing was shared.
2. The submission is `pending_review`. The Funding Radar tag, review page and a short notice show its state: pending review, published, not accepted, or withdrawn. A repeat click or a second organization passing the same grant reports "already submitted".
3. An administrator opens **FinCap Review**. Any pending submission without a summary gets one drafted automatically (see below), and the last-verified date defaults to today on screen. The editor reads the card, edits anything that is not right, and approves, rejects, or withdraws. Approval writes the public snapshot (`published`).
4. The public site reads only that snapshot through `/.netlify/functions/fincap-feed?view=opportunities`. The newsletter export reads the same snapshot through `/.netlify/functions/fincap-feed?view=newsletter&issue=YYYY-MM-DD` (add `&format=md` for a readable version). `netlify.toml` also maps `/api/fincap/opportunities` and `/api/fincap/newsletter` to these, but callers use the function path because the redirect aliases were not applied on the deploy preview.

Ordinary Pass and Qualify (Pursue) are unchanged.

## Public fields (allowlist)

Defined once in `fincap_build_published`: title, funder, official source link, amount (only when marked verified), deadline and timezone (only for a fixed deadline), deadline kind and whether it is verified, eligible applicants, geography, program areas, original summary, last verified date. Never exposed: organization ids or names, who passed, reasons, notes, activity, fit scores, `ai_summary` (generated with organization context), uploaded documents, Grant Factory data. The Netlify function re-projects every row through the same allowlist.

The summary is never copied from `ai_summary` (written with organization context) or pasted from the funder's `summary`. When FinCap Review opens, the Netlify function `fincap-draft-summary` (admin only, Claude Opus 5.5 at low effort) writes a 2 to 4 sentence, third-person draft from public facts only: title, funder, who can apply, geography, program areas, and the funder's own description and requirements. It never sees which organization passed, fit data, or notes. The draft is saved through `fincap_admin_edit`, so it is versioned and audited like a manual edit, and it is never published until an editor approves. "Draft summary" on a card writes a fresh draft on demand. Approval is still blocked when the summary is outside 40 to 700 characters, names an organization that passed on the grant, or reads as organization-specific. That check is a guard, not a substitute for reading it.

Cost: one model call per submission, made only when an administrator opens the queue and the summary is empty, or when an editor asks for a new draft. Requires `ANTHROPIC_API_KEY`, which the site already uses for scoring.

## Authorization

- Tables are private (RLS on, no client grants). Members use SECURITY DEFINER functions that check `org_memberships` for `auth.uid()`.
- Review, edit, approve, reject, withdraw and recording an issue require a row in `admins` (the existing administrator role). Source verification flags never approve anything.
- The public list and the export are executable only by `service_role`, used only inside the Netlify function.

## Deduplication and cycles

Identity is the registry program when present, else the normalized source URL, else the opportunity row. The cycle is the registry cycle key, else the deadline year, else "undated". One submission per identity and cycle; a new annual cycle gets its own review. Retries and concurrent clicks are serialized by an advisory lock and a unique constraint.

## Source changes and expiry

If title, link, deadline, amount, geography or active status changes on the source after approval, the publication is flagged "needs re-check". The approved text stays as it was, shows "being re-verified" publicly, and is held out of newsletter exports until an editor re-approves. Expired fixed deadlines leave the public list and exports automatically (deadline day in its stated timezone). Rolling and unknown dates are never given a date.

## Newsletter

`fincap_newsletter_export` is read-only. Included: approved, not awaiting re-check, still open on the issue date, and new, materially updated since the last recorded issue, or (optionally, `repeat_within_days`) a deadline reminder. Default cutoff: noon America/New_York on the issue date. Uncertain deadlines carry a `deadline_flag`. After the issue is final, **FinCap Review > Newsletter > Record these items as included** stores what ran. It never sends email and only marks an issue sent if you tick the box.

## Cost controls

No AI calls, scoring, scheduled jobs, new service or new database. Incremental usage: one small `fincap_my_shares` call per app load (bounded to 500 narrow rows, usually empty); one transaction per Pass & Share; admin screen loads at most 50 rows on demand; the public feed is CDN-cached for 5 minutes, so public traffic is not database traffic; the source-change trigger fires only when seven specific columns are updated and does one indexed lookup. Existing cost driver, not changed here: the app loads every opportunity (`select *`, about 1,650 rows) on each load and organization switch. Trimming that is a separate, worthwhile change.

## Rollback

Additive migration. `supabase/fincap-sharing/rollback.sql` removes the objects. Reverting the PR removes the buttons; before the migration is applied the buttons show a failure notice and change nothing.
