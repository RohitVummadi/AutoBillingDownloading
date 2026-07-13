// LIVE-SITE VERIFICATION REQUIRED: Every value in this file must be checked
// against the authenticated Duke portal. Accessible locators in DukePortal are
// attempted first; these stable-attribute selectors are fallbacks. Generated
// CSS class names are intentionally not used.
export const dukeAccessibleNames = {
  usernameField: /user(?:name)?|email/i,
  passwordField: /password/i,
  loginSubmit: /sign in|log in|login|continue/i,
  printBills: /print bills?/i,
  clearSelections: /clear (?:all )?selections?|deselect all/i,
  confirmClearSelections: /confirm|clear|yes/i,
  paginationRegion: /pagination|pages?/i,
  firstPage: /first/i,
  previousPage: /previous|prev/i,
  nextPage: /next/i,
  rowSelectionCheckbox: 'checkbox',
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

  billingTable:
    'table[aria-label*="bill" i], table[data-testid*="bill" i], table[id*="bill" i]',
  tableHeaders: 'thead tr:last-child th',
  tableRows: 'tbody tr',
  tableCells: ':scope > th, :scope > td',
  rowSelectionCheckbox: 'input[type="checkbox"]',
  paginationRegion:
    'nav[aria-label*="pagination" i], [role="navigation"][aria-label*="page" i], [data-testid*="pagination" i]',
  pageIndicator:
    '[aria-current="page"], [data-testid*="page-indicator" i], [aria-label*="page" i][role="status"]',
  tableLoadingIndicator:
    '[aria-busy="true"], [role="progressbar"], [data-testid*="loading" i]',
  firstPageButton:
    'button[aria-label*="first" i], a[aria-label*="first" i], [data-testid*="first-page" i]',
  previousPageButton:
    'button[aria-label*="previous" i], a[aria-label*="previous" i], [data-testid*="previous-page" i]',
  nextPageButton:
    'button[aria-label*="next" i], a[aria-label*="next" i], [data-testid*="next-page" i]',

  selectedCount:
    '[data-testid*="selected-count" i], [aria-label*="selected" i][role="status"], [data-selected-count]',
  printBillsButton:
    'button[data-testid*="print-bill" i], button[aria-label*="print bill" i], a[aria-label*="print bill" i]',
  clearSelectionsButton:
    'button[data-testid*="clear-selection" i], button[aria-label*="clear selection" i], a[aria-label*="clear selection" i]',
  confirmClearSelectionsButton:
    '[role="dialog"] button[data-testid*="confirm" i], [role="dialog"] button[aria-label*="confirm" i]',

  // LIVE-SITE VERIFICATION REQUIRED: restrict these further if Duke serves
  // unrelated PDFs while the billing table is open.
  pdfResponseUrlHints: ['pdf', 'printbill', 'print-bill', 'statement'],
} as const;
