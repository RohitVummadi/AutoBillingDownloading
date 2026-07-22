# Utility Bill Downloader

A TypeScript/Playwright command-line application that signs in to a utility portal, finds bills whose billing-cycle start dates fall within an inclusive calendar-date range, selects all matches, downloads each bill individually, validates every PDF, and merges them into one PDF.

Duke Energy is the first portal adapter. The batching, manifest, PDF, retry, logging, output-path, and CLI code is portal-independent so another adapter can be added without duplicating that workflow.

> **Live Duke verification is required.** Duke routes and page markup can vary by operating company, account type, and site release. The URL defaults in `src/portals/duke/config.ts` and every fallback selector in `src/portals/duke/selectors.ts` are deliberately marked `LIVE-SITE VERIFICATION REQUIRED`. Verify them against an authorized Duke account before relying on unattended runs.

## Prerequisites

- Node.js 20 or newer
- npm
- A Duke account that can view the billing-history table and print bills
- Network access to the Duke portal
- Enough local disk space for the original batch PDFs and the combined PDF

The unit tests do not contact Duke. A real portal run requires valid credentials and may require adapting the marked URLs/selectors to the live site.

## Install

Install the Node.js dependencies from the repository root:

```powershell
npm install
```

If PowerShell reports that `npm.ps1` cannot run because script execution is disabled, use the Windows command shims (`npm.cmd` and `npx.cmd`) for the same commands.

Install the Chromium browser used by the application:

```powershell
npx playwright install chromium
```

On a Linux host that also needs Playwright's operating-system packages, use:

```bash
npx playwright install --with-deps chromium
```

## Configure Duke credentials

Create a local `.env` from the tracked template:

```powershell
Copy-Item .env.example .env
```

Set the two required values in `.env`:

```dotenv
DUKE_USERNAME=your-duke-username
DUKE_PASSWORD=your-duke-password
```

Credentials are checked before Playwright opens a browser. Missing values produce a clear error. `.env` is ignored by Git, and the application redacts configured credentials and common cookie, authorization, session, and token values from errors. Do not commit `.env`, downloaded bills, authentication state, or logs.

The optional home, login, and business billing-history URL overrides are described in [Live Duke configuration](#live-duke-configuration).

## Run the downloader

Show the CLI help (invoke `tsx` directly because npm may consume `--help`):

```powershell
npx tsx src/index.ts --help
```

`--portal`, `--start-date`, and `--end-date` are required. `--output-dir` defaults to `./downloads`. Arguments and dates are validated before the browser opens. Duke runs every Business Partner in the top-right selector by default; add `--current-account-only` to process only the account active at startup.

### Headed mode (default)

Omit `--headless` to keep the browser visible. This is the best mode for the first live-site run:

```powershell
npm run download -- `
  --portal duke `
  --start-date 2025-06-01 `
  --end-date 2025-06-30 `
  --output-dir .\downloads
```

On some npm 10 + PowerShell installations, npm strips the option names and
passes only their values to the script. This application accepts that exact
shape as a compatibility fallback. The direct form is also available:

```powershell
npx tsx src/index.ts --portal duke --start-date 2025-06-01 --end-date 2025-06-30 --output-dir .\downloads
```

### Headless mode

Add `--headless` for an unattended browser:

```powershell
npm run download -- `
  --portal duke `
  --start-date 2025-06-01 `
  --end-date 2025-06-30 `
  --output-dir .\downloads `
  --headless
```

### Download June-starting bills for mapped buildings

To save one Duke bill per account from a CSV, use an account map with `Account
Number` and `Building Name` columns. This command accepts only billing cycles
that start in June 2026; their ending date is deliberately ignored. Other
columns may be duplicated or vary between rows; they are ignored. Building
names may contain commas when properly quoted.

```powershell
npm.cmd run download -- `
  --portal duke `
  --account-map '.\Duke Meters LLM data.csv' `
  --billing-start-month 2026-06
```

This creates `downloads\named-building-bills` and writes one PDF named for each
building. If a building name would produce the same Windows filename as another
one, the account number is appended to both filenames. `targeted-run.json` in
that folder records downloaded, reused, unmatched, and failed accounts. An
unmatched account does not stop the other downloads. On a later run, an existing
valid PDF is reused only when it is for the same Duke billing cycle.

Targeted Duke scans request 25 billing-history rows per page when the live portal
offers that page-size control. Each matching account is downloaded and validated
as soon as its current Business Partner scan finds it, before the scan moves on
to later pages or partners.

The targeted-run log explains each decision: page ranges, real parsed-row counts,
rows in the requested month, target-account matches, remaining targets, download
start/completion, and partner-scan completion.

Use `--output-dir <folder>` with the command above to choose another destination,
or `--current-account-only` to limit the search to the active Business Partner.

### Date-range behavior

Dates must be real calendar dates in `YYYY-MM-DD` format, and the start date cannot be later than the end date. Bill matching uses only the billing-cycle start date, with both boundaries inclusive.

```text
billingCycleStart >= requestedStart && billingCycleStart <= requestedEnd
```

Calendar dates are represented at UTC midnight internally so a local timezone cannot shift a date by one day. A cycle such as `05/15/2025 - 06/15/2025` therefore matches a request beginning on `2025-06-01`.

### Choosing an output directory

Pass any local output root with `--output-dir`; missing directories are created automatically. The application resolves that root and safely creates its own portal/date children beneath it. For example:

```powershell
npm run download -- --portal duke --start-date 2025-06-01 --end-date 2025-06-30 --output-dir D:\UtilityBills
```

produces:

```text
D:\UtilityBills\
  duke\
    2025-06-01-to-2025-06-30\
      run-summary.json
      accounts\
        account-1102669801\
          batch-001.pdf
          combined-bills-2025-06-01-to-2025-06-30.pdf
          manifest.json
```

The batch PDFs are retained after the combined PDF is created. Each discovered Business Partner receives its own folder and manifest before account activation begins; `run-summary.json` records completed and failed accounts. A per-account manifest reports `accountStatus` as `completed`, `pending`, or `failed`, so a completed zero-bill scan is distinguishable from an account that could not be scanned.

## How a run works

### Scan and duplicate prevention

The Duke adapter discovers every Business Partner in the scrollable selector, activates one at a time, then returns to the first billing-table page and scans all available table pages (up to the 500-page safety guard). It selects bills whose billing-cycle start date is within the requested start/end dates, inclusively; the billing-cycle end date does not affect matching. An unreadable row is logged and skipped so it does not prevent later bills from being processed. It maps columns from normalized header text instead of assuming a fixed column order. Account number, service address, billing cycle, and a row selection checkbox are required; due date and amount due are recorded when present.

Each bill is tracked with this unique key:

```text
accountNumber|billingCycleStart|billingCycleEnd
```

Billing-cycle dates in the key use `YYYY-MM-DD`. Duke cycles may appear as `June 10, 2026 - July 09, 2026`; repeated table rows with the same key are ignored during scanning.

Pagination waits for the table rows to change and for the replacement rows to be ready. Page fingerprints include the page indicator and prevent loops; traversal stops with an error rather than exceeding 500 pages.

### Selection and individual downloads

Matching bills are split into selection batches of at most 25 because Duke does not allow more than 25 selected bills at once. The terminal prints each bill's account number, service address, and billing cycle as it is selected.

The Duke adapter:

1. Clears stale selections and verifies a selected count of zero.
2. Returns to the first table page and traverses every available page, up to the 500-page safety guard.
3. Selects only rows whose account number and billing-cycle dates match a target key.
4. Leaves earlier selections checked while moving to later pages, because Duke is expected to preserve selection state across pagination.
5. Requires every target key to occur exactly once and rejects any selected non-target row.
6. Verifies Duke's displayed selected-account count equals the current batch size.
7. Downloads each selected bill PDF link one at a time.
8. Merges and validates that batch's individual bill PDFs.
9. Clears selections with Duke's global control, or unchecks selected rows across every page as a fallback, then verifies the selected count is zero before selecting the next batch.

A failed batch gets an initial attempt plus up to three retries, after backoffs of 2, 5, and 10 seconds. Each retry clears selections, returns to the first page, selects that batch again, and rechecks the count. After all batches complete, their PDFs are merged into the final combined PDF.

### PDF capture and validation

The Duke-specific download helper listens concurrently for the portal behaviors commonly used by Print Bills:

- a normal Playwright download
- a popup or new tab containing a PDF, including `blob:` and `data:` URLs
- a PDF network response
- an authenticated HTTP(S) PDF URL fetched through the browser context

It does not assume that clicking Print Bills navigates the current page. The default download timeout is 90 seconds.

Before a batch is accepted, its file must:

- exist as a readable regular file
- be at least 1,024 bytes
- start with the `%PDF` signature
- not look like an HTML login or generic error page
- parse successfully with `pdf-lib`

After all batches pass, `pdf-lib` copies their pages into the combined file in batch-number order. The combined file is validated again. A failed batch prevents creation of the combined PDF.

### Resuming a run

The manifest is updated as work succeeds. On a later run for the same portal and date range, an existing batch is skipped only when:

- the previous manifest belongs to the same portal and requested date range,
- the batch number, filename, and included keys match,
- the manifest says the batch passed validation, and
- the existing PDF still passes validation now.

Matching previous checkpoints are copied into the new in-progress manifest before batch processing starts, so an interruption cannot erase already validated work. If the portal's bill list changes, any batch whose exact membership remains unchanged can still be reused; changed batches are downloaded again.

There is no overwrite flag. To force a completely fresh run, remove that portal/date output folder first. Never remove a folder while another run is using it.

### Manifest

`manifest.json` is stored beside the PDFs in the portal/date folder. It is written after scanning and updated after successful batches and final merging; a batch that exhausts all retries also gets a failed validation record. The manifest therefore describes partial progress after a failure. An unreadable, malformed, or structurally invalid existing manifest stops the run instead of being silently overwritten.

It contains:

- portal, requested start/end dates, total bills, and total batches
- download start/completion timestamps and the final merged filename
- one record per batch with its number, bill count, PDF filename, download timestamp, validation result, and included unique keys
- one record per bill with portal, account, service address, cycle dates, optional due date/amount, unique key, batch number, and batch PDF filename

Only non-sensitive billing metadata is written. Credentials, cookies, session tokens, authentication headers, and PDF contents are not included or logged.

## Live Duke configuration

### URLs

The following defaults in `src/portals/duke/config.ts` require verification against the live Duke experience:

| Purpose | Default | Override |
| --- | --- | --- |
| Login | `https://my.duke-energy.com/login` | `DUKE_LOGIN_URL` |
| Business billing history | `https://businessportal2.duke-energy.com/billinghistory` | `DUKE_BUSINESS_BILLS_URL` |

Override either route in `.env` without changing source:

```dotenv
DUKE_LOGIN_URL=https://verified-login-route.example
DUKE_BUSINESS_BILLS_URL=https://verified-business-billing-history-route.example
```

Use only trusted Duke URLs. URL values can contain credentials or session data in some systems, so do not place temporary authenticated links in `.env` or commit them.

### Selectors

`DukePortal.ts` tries accessible role, label, placeholder, and text locators where possible, then uses the stable-attribute fallbacks in `src/portals/duke/selectors.ts`. Every selector value below requires live-site verification:

| Area | Selector keys to verify |
| --- | --- |
| Accessible labels/names/roles | every key in `dukeAccessibleNames` (`usernameField`, `passwordField`, `loginSubmit`, `printBills`, `clearSelections`, `confirmClearSelections`, `paginationRegion`, `firstPage`, `previousPage`, `nextPage`, `rowSelectionCheckbox`) |
| Login | `usernameInput`, `passwordInput`, `loginSubmit`, `loginSuccess`, `loginError`, `loginChallenge` |
| Billing table | `billingTable`, `tableHeaders`, `tableRows`, `tableCells`, `rowSelectionCheckbox` |
| Pagination | `paginationRegion`, `pageIndicator`, `tableLoadingIndicator`, `firstPageButton`, `previousPageButton`, `nextPageButton` |
| Selection/actions | `selectedCount`, `printBillsButton`, `clearSelectionsButton`, `confirmClearSelectionsButton` |
| PDF response detection | every value in `pdfResponseUrlHints` |

Prefer an accessible name or a stable `name`, `id`, `aria-*`, or `data-testid` attribute. Do not copy generated CSS class names. If the table's visible header wording changes, update the header aliases in `src/portals/duke/tableColumns.ts`; that is separate from changing the table DOM selectors.

After any live-site configuration change, run:

```powershell
npm run typecheck
npm test
```

Then make one headed run over a small date range and verify the selected count, downloaded batch, and manifest before using headless mode.

## Troubleshooting

### Login failures

- Confirm `.env` exists in the repository root and contains non-empty `DUKE_USERNAME` and `DUKE_PASSWORD` values. Variable names are case-sensitive.
- Start in headed mode and confirm the configured login URL is the correct Duke route for the account's operating company and account type.
- If fields or the submit button are not found, verify `usernameInput`, `passwordInput`, and `loginSubmit` plus the fields' accessible labels/placeholders.
- If valid login succeeds visually but the application times out, update `loginSuccess`. If a rejected login is not recognized, update `loginError`.
- A redirect back to a visible password form while opening billing history means the authenticated session was not established. Check the billing URL, account permissions, and any MFA, CAPTCHA, consent, or terms step that Duke added. Such a new interactive step requires an adapter change; do not bypass Duke security controls.
- The adapter reports common invalid-credential and locked/disabled-account messages. Resolve an account lock with Duke rather than repeatedly retrying credentials.

The default navigation/login timeout is 45 seconds. Do not add credentials, cookies, or screenshots of bill contents to issue logs.

### Required columns are missing

The error lists the normalized headers the adapter found. Confirm `billingTable`, `tableHeaders`, and `tableRows` point to the actual data table, especially if the page contains more than one bill-related table.

Required semantic columns are Account number, Service address, and Billing cycle; each data row must also expose a checkbox. Add the live header wording to the appropriate alias list in `src/portals/duke/tableColumns.ts` rather than hardcoding a column index. Billing cycles must parse as `MM/DD/YYYY - MM/DD/YYYY` and the start cannot be after the end. If a checkbox moved or is no longer exposed with the checkbox role or an `input[type="checkbox"]`, update the row-checkbox logic in `DukePortal.ts`.

### Pagination stalls, stops early, or loops

- Verify `firstPageButton`, `previousPageButton`, and `nextPageButton` identify the correct controls and that Duke expresses disabled state through normal `disabled`/`aria-disabled` semantics.
- Verify the billing table text changes after each page click, `tableLoadingIndicator` covers Duke's busy state, and `pageIndicator` identifies the active page for loop detection.
- If the error says the table did not change, check whether Duke now updates a nested grid, uses delayed loading, or requires a different table selector.
- If a previously visited fingerprint appears, inspect whether the Next locator points backward, wraps around, or changes a different table. Loop protection intentionally stops the run.
- A run stops at the hard safety limit of 500 pages. Raise that limit in `src/portals/duke/config.ts` only after confirming that the traversal is genuinely advancing.

### Selection-count mismatches

- Verify `selectedCount` points to the visible batch counter or an element with `data-selected-count`. The parser uses the first integer in its attribute/text.
- Confirm row checkboxes remain selected when moving between pages. Persistent selection is a Duke adapter assumption required for cross-page batches.
- Check that account number and billing-cycle text remain identical between scanning and selection. These values form the key; row indexes are never used.
- Duplicate live rows with the same expected key are an error during selection, even though duplicate scan results are filtered. Resolve the source or refine how the adapter identifies a bill rather than disabling the check.
- If stale non-target rows are reported, verify the global clear control and confirmation selector. When no working global control exists, the adapter traverses all pages and unchecks rows, then verifies zero.

Do not bypass the count verification: it prevents silently downloading missing or unrelated bills.

### PDF downloads time out or fail validation

- Verify `printBillsButton` identifies the enabled action shown after selecting accounts.
- Observe a headed run and determine whether Duke emits a download, popup, PDF response, or authenticated URL. If its behavior changed, update `src/portals/duke/downloadPdf.ts` for that observed mechanism.
- Check `pdfResponseUrlHints`. Make hints specific enough to avoid unrelated PDFs but broad enough to recognize Duke's bill endpoint; content type and content disposition are also detected automatically.
- HTML saved instead of PDF usually indicates an expired session, login redirect, access-denied response, or server error. Fix authentication/routing instead of weakening PDF validation.
- A file under 1,024 bytes, without `%PDF`, or unreadable by `pdf-lib` is rejected. The application retries the entire selection/download operation after 2, 5, and 10 seconds.
- Confirm the output drive is writable and has free space. Atomic writes create a temporary file beside the destination before renaming it.

If a previous validated batch is unexpectedly skipped, remove its batch PDF (causing revalidation to fail and a redownload) or remove the entire run folder for a fully fresh run.

## Add another portal adapter

Shared orchestration depends only on `BillingPortal`, so a second portal should not require changes to batching, manifests, merging, validation, retries, or logging.

For a Blue Ridge adapter, for example:

1. Create `src/portals/blue-ridge/BlueRidgePortal.ts`, `config.ts`, and `selectors.ts`, plus a portal-specific download helper if its PDF flow needs one.
2. Implement every method in `src/types/BillingPortal.ts`: `login`, `navigateToBills`, `scanBills`, `selectBatch`, `downloadSelectedBatch`, `clearSelections`, and `verifySelectionCount`. Set `name` to the exact CLI portal name.
3. Keep its URLs, selectors, login rules, table/pagination rules, selection behavior, and download behavior inside that folder. Return shared `Bill` objects and build keys with `createBillUniqueKey`.
4. Make `scanBills` traverse all of that portal's pages, deduplicate rows, and apply the requested billing-cycle start-date range. Never return another portal's name in a bill.
5. Add the new name to `SUPPORTED_PORTALS` in `src/utils/arguments.ts`, then import and construct the adapter in the switch in `src/index.ts`. Validate that portal's credentials before calling `runPortal`.
6. Document its environment variables in `.env.example` and add unit tests for any portal-specific parsing or mapping logic. Live-site tests should remain separate from the unit suite.
7. Run the checks below, then validate a small headed download with an authorized test account.

Expected layout:

```text
src/portals/
  duke/
    DukePortal.ts
    config.ts
    selectors.ts
  blue-ridge/
    BlueRidgePortal.ts
    config.ts
    selectors.ts
```

## Development checks

```powershell
npm run typecheck
npm test
npm run build
```

There is currently no lint script configured in `package.json`. Unit tests must not require access to the live Duke website.

## Security and repository hygiene

- Never commit `.env`, `downloads/`, bills, browser authentication state, or logs.
- Never add credentials, cookies, tokens, or authentication headers to debug output.
- Do not log PDF/bill contents.
- Use only accounts and billing documents you are authorized to access.
- The browser context and browser are closed in a `finally` block. Successful runs exit with code 0; failures report an error and exit nonzero.
