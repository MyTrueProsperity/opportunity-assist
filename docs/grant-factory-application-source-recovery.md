# Recover an application import

Open the existing application in Grant Factory and read **Application source**.
The card shows the captured funder, program, cycle, deadline, verification status,
and the URLs checked. Missing information stays **Unknown**.
The registry's internal cycle key (for example `year:2026`) remains in source
provenance; it is not substituted for a funder-stated application round.

- **Source link is broken:** the source returned HTTP 404 or 410. Find the current
  official page for the specific grant program and cycle.
- **Public access was blocked:** HTTP 401/403/429, robots restrictions or an
  anti-bot page prevented reading. This alone does not prove applicant login is required.
- **Application requires sign-in:** a sign-in form with no public question set,
  or explicit application portal instructions, was found. Sign in yourself,
  download the full application, and upload it or paste all its questions.
- **Select the specific grant program:** the captured lead is unresolved or
  several application links are offered. Choose the intended program and cycle;
  an organization-wide grants directory is not a complete application.
- **Source is incomplete / questions were not found:** supply the complete
  application, including conditional fields, formats, attachments and instructions.
- **Source could not be read:** check the source link and retry after the network
  or server problem is resolved, or upload the original.

Choose **Retry with corrected source**, enter the specific official application
or program link, and identify the funder's grant program and cycle where known.
Confirm that the source belongs to your intended application. Keep a genuinely
unknown cycle blank; OA does not invent one. Use **Upload complete application**
for downloaded documents or protected portals.

A retry uses at most three public pages and no AI calls. It retains the application
ID and saved answers. A failed retry preserves the previously accepted source,
questions, answers, identity, and review state; its result appears separately.
An unreadable downloaded original remains in the Document Vault for recovery.

When a replacement is readable, existing questions and answers remain unchanged
until you review and apply the proposed repairs in **Source checklist**. Matched
fields keep their IDs and answers; missing fields are retained unless you explicitly
archive them. Original documents and application history remain available.
Save any unsaved answer edits before retrying.

Captured source metadata and user-selected identity remain separate from verified
requirements. Confirm the complete source checklist and current program/cycle
before approving the application. OA never logs in to a portal or submits a grant.

Existing failed imports receive an accurate read-only explanation from their saved
attempts. Opening an application does not rerun an import or repair production data.
This change requires no database migration or new dependency and does not alter
research budgets, paid research flags, provider credentials, or scheduled jobs.
