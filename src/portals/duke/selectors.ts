// LIVE-SITE VERIFICATION REQUIRED: Every value in this file must be checked
// against the authenticated Duke portal. Accessible locators in DukePortal are
// attempted first; these stable-attribute selectors are fallbacks. Generated
// CSS class names are intentionally not used.
export const dukeAccessibleNames = {
  signInRegister: /sign in\s*\/\s*register/i,
  usernameField: /user(?:name)?|email/i,
  passwordField: /password/i,
  loginSubmit: /sign in|log in|login|continue/i,
  clearSelections: /clear (?:all )?selections?|deselect all/i,
  confirmClearSelections: /confirm|clear|yes/i,
  paginationRegion: /pagination|pages?/i,
  firstPage: /first/i,
  previousPage: /previous|prev/i,
  nextPage: /next/i,
  rowSelectionCheckbox: 'checkbox',
  businessPartner: /business partner/i,
} as const;

export const dukeSelectors = {
  usernameInput:
    'input[autocomplete="username"], input[name="username"], input[id*="username" i], input[type="email"]',
  passwordInput:
    'input[autocomplete="current-password"], input[name="password"], input[id*="password" i], input[type="password"]',
  loginSubmit:
    'button[type="submit"], input[type="submit"], button[data-testid*="login" i]',
  loginSuccess:
    '[data-testid="account-dashboard"], [aria-label*="account dashboard" i], a[href*="logout" i], button[aria-label*="sign out" i]',
  loginError:
    '[role="alert"], [aria-live="assertive"], [data-testid*="login-error" i], [data-testid*="auth-error" i]',
  loginChallenge:
    'input[autocomplete="one-time-code"], [data-testid*="mfa" i], [data-testid*="verification" i], form[action*="reset-password" i]',

  // Keep pagination scoped to Duke's actual bill grid. A generic `table`
  // selector can bind to unrelated layout/summary tables and endlessly click
  // their controls while the bill rows remain unchanged.
  billingTable:
    'table[aria-label*="bill" i], table[data-testid*="bill" i], table[id*="bill" i], table:has(th:has-text("Account")):has(th:has-text("Address")):has(th:has-text("Billing Cycle"))',
  tableHeaders: 'thead tr:last-child th',
  // LIVE-SITE VERIFICATION REQUIRED: Duke's active sort is commonly exposed
  // through aria-sort plus an icon/class on the header. Keep this broad enough
  // to inspect both without relying on generated CSS class names.
  tableSortSignal: '[aria-sort], [data-sort], [data-sort-direction], [aria-label], [title], svg, i, span',
  tableRows: 'tbody tr',
  tableCells: ':scope > th, :scope > td',
  rowSelectionCheckbox: 'input[type="checkbox"]',
  paginationRegion:
    'nav[aria-label*="pagination" i], [role="navigation"][aria-label*="page" i], [data-testid*="pagination" i]',
  pageIndicator:
    '[aria-current="page"], [data-testid*="page-indicator" i], [aria-label*="page" i][role="status"], .pagination .active, [class*="pagination" i] [class*="active" i]',
  paginationRange:
    '[data-testid*="pagination" i] [role="status"], [aria-live][class*="pagination" i], [aria-label*="pagination" i] [role="status"]',
  tableLoadingIndicator:
    '[aria-busy="true"], [role="progressbar"], [data-testid*="loading" i]',
  firstPageButton:
    'button[aria-label*="first" i], a[aria-label*="first" i], [data-testid*="first-page" i]',
  previousPageButton:
    'button[aria-label*="previous" i], a[aria-label*="previous" i], [data-testid*="previous-page" i]',
  nextPageButton:
    'button[aria-label*="next" i], a[aria-label*="next" i], [data-testid*="next-page" i], .pagination .next a, .pagination [class*="next" i] a',
  rowsPerPageControl:
    '[class*="paginationDrop" i][role="button"], [data-testid*="rows-per-page" i][role="button"], [aria-label*="rows per page" i][role="button"]',

  selectedCount:
    '[data-testid*="selected-count" i], [aria-label*="selected" i][role="status"], [data-selected-count]',
  // The current Business Portal labels the row action "View Bill"; older
  // releases exposed "View PDF" or used the tabledownloadlink class. Each bill
  // is downloaded individually through this per-row link rather than a bulk
  // "Print Bills" action, which the live portal does not render.
  billPdfLink:
    'a[aria-label*="view pdf" i], a[aria-label*="view bill" i], a.tabledownloadlink, a:has-text("View Bill"), a:has-text("View PDF")',
  clearSelectionsButton:
    'button[data-testid*="clear-selection" i], button[aria-label*="clear selection" i], a[aria-label*="clear selection" i]',
  confirmClearSelectionsButton:
    '[role="dialog"] button[data-testid*="confirm" i], [role="dialog"] button[aria-label*="confirm" i]',

  // LIVE-SITE VERIFICATION REQUIRED: observed Business Partner menu shape can
  // vary by business account. These are intentionally attribute/role based.
  businessPartnerSelector:
    '[data-testid*="business-partner" i], [aria-label*="business partner" i], [name*="business-partner" i], select[id*="business-partner" i], button[id*="business-partner" i]',
  businessPartnerMenu:
    '[role="listbox"], [role="menu"], [data-testid*="business-partner-menu" i], [data-testid*="account-selector-menu" i]',
  businessPartnerOption:
    '[role="option"], [role="menuitemcheckbox"], label:has(input[type="checkbox"]), li:has(input[type="checkbox"]), div:has(> input[type="checkbox"])',
  businessPartnerOptionCheckbox: 'input[type="checkbox"], [role="checkbox"]',

  // LIVE-SITE VERIFICATION REQUIRED: restrict these further if Duke serves
  // unrelated PDFs while the billing table is open.
  pdfResponseUrlHints: ['pdf', 'printbill', 'print-bill', 'statement'],
} as const;
