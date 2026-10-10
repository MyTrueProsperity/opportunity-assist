# C official-source pilot — October 9, 2026

Bill authorized this read-only pilot and continuing the database/app release. Five named Florida official URLs were fetched once by the application's existing transport, with robots checks, public-address validation and response limits. Fetches succeeded with HTTP 200 and no redirects. Fetch times were October 10 00:25:57–00:26:04 UTC (October 9 Eastern). No paid model, source API subscription, database write, job execution or grant publication was involved.

**Result: 0 of 5 pages eligible for automatic publication. C must remain disabled.** This is not a successful live-publication acceptance test. It validates these refusals and exposes coverage limits; synthetic positive tests establish mechanism behavior only.

| Official source | Findings from complete notice | C disposition |
| --- | --- | --- |
| [Coastal Partnership Initiative](https://floridadep.gov/rcp/fcmp/content/grants) | Page combines CPI and state-agency grant programs. The upcoming/current CPI period is described as September 1–October 31, 2026. Nonprofits need an eligible local-government partner and coastal-area eligibility; linked forms and rules matter. It also describes the preceding cycle as closed. | Human review: multiple programs/cycles, partner/geography rules and linked requirements. |
| [General Program Support](https://dos.fl.gov/cultural/grants/grant-programs/general-program-support/) | FY 2027–28 applications are closed and the next deadline is undetermined. Public entities and Florida nonprofit tax-exempt corporations have further discipline, designation and organizational restrictions. | Human review; no verified open cycle or future application deadline. |
| [Identity Theft and Fraud FY26–27](https://www.fdle.state.fl.us/fdle-grants/open-funding-opportunities/idtf/fy26-27-idtf) | Submissions start October 1, 2026; funding is first come, first served until obligated. Eligible applicants are local law-enforcement agencies, not ordinary nonprofits. Project end June 30, 2027 is not an application deadline. Funding depends on appropriation and an external portal/recipient guide. | Human review; no fixed application deadline and additional rules. Do not advertise this as a nonprofit opportunity. |
| [Land and Recreation Grants](https://floridadep.gov/lands/land-and-recreation-grants) | Directory combines several programs with different eligibility and timing, including an application window ending October 15, 2026. | Human review: select and inspect a complete single-program notice first. |
| [Cultural Facilities](https://dos.fl.gov/cultural/grants/grant-programs/cultural-facilities/) | FY 2027–28 applications are closed; next deadline is undetermined. Facilities, ownership/lease and other guideline conditions need review. | Human review; no verified open cycle or future application deadline. |

The first parser run misidentified navigation grant links as programs. The corrected detail adapter uses the primary page heading for identity, refuses ambiguous headings and additional grant sections, and retains the full document for evidence and restriction checks. Local regressions cover navigation, multiple headings and requirements outside the main content. Reanalysis of the saved responses still refused all five notices; no additional live fetch was needed.

SHA-256 whole-response receipts, in table order:

- `0d659b84206618fce915498912896f30ce407a788b2e9e69f64d16a334671178`
- `18043030804bef7ccc5362ddfef8901acaad7f3200d846d694265eac76cd6ee3`
- `69d8316e2018e9a18113b3989600df2abd3d13559022303df1fa24e2f45b8921`
- `7f1bac946874c256d44a15d949f70ce83ffe043b0c6e760a1929fa6f497b1528`
- `84b655f0384f8ab5f3123fbfabf5f6d92d0c143d3c41c16ed8557a3438ac2a1d`

Private local snapshots and machine-readable reports are in the ignored `work` directory of the C review checkout. They are not shipped to browsers or submitted as live evidence.

A bounded production prerequisite read found only Florida enabled, existing engine/automatic-approval controls enabled, 3,117 queued jobs and one paused job. This release does not claim, retry, drain or alter that queue or enable existing controls. Migration installs disabled C settings with an empty source allowlist; no pilot URL is approved for automatic publication.

Next acceptance condition: identify a real complete single-program official notice supported by an exact-source adapter, review every application restriction, and demonstrate a fresh qualifying receipt with source-grounded dates before activating the two C switches. Keep uncertain nonprofit eligibility in human review.
