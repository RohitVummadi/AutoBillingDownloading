import { createHash } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';

import type { BrowserContext, Locator, Page } from 'playwright';

import type { Bill } from '../../types/Bill.js';
import { createBillUniqueKey, normalizeAccountNumber, normalizeBillField } from '../../types/Bill.js';
import type { BillingPortal } from '../../types/BillingPortal.js';
import type { PortalAccount } from '../../types/PortalAccount.js';
import {
  isBillingCycleStartInRange,
  parseBillingCycle,
  parseIsoDate,
} from '../../utils/dates.js';
import type { Logger } from '../../utils/logging.js';
import { contextualError, errorMessage } from '../../utils/logging.js';
import type { DukeConfig, DukeCredentials } from './config.js';
import { downloadDukePdf, DukeSessionExpiredError } from './downloadPdf.js';
import { DukeBatchSelectionTracker } from './batchSelection.js';
import { mergePdfs } from '../../pdf/mergePdfs.js';
import { dukeAccessibleNames, dukeSelectors } from './selectors.js';
import { toDukePortalAccount } from './accounts.js';
import {
  createDukeBillRowsFingerprint,
  canUseDukeDescendingEarlyStop,
  classifyDukeBillForDiscovery,
  classifyDukeBillingCycleStart,
  detectDukeSortDirection,
  hasDukePaginationAdvanced,
  isDukePaginationControlEnabled,
  parseDukePaginationMetadata,
  shouldClickForDescendingBillingCycleSort,
  type DukeSortDirection,
} from './pagination.js';
import { dukeEmptyStateMessage, isRealDukeBillRow } from './readiness.js';
import type { DukeColumnMap } from './tableColumns.js';
import { mapDukeColumns } from './tableColumns.js';

interface ParsedBillRow {
  bill: Bill;
  checkbox: Locator;
  pdfLink: Locator | null;
}

function endOfMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0));
}

interface BillingTableReadiness {
  fingerprint: string;
  realRowCount: number;
  firstAccountNumber: string | null;
  firstBillingCycle: string | null;
  emptyMessage: string | null;
  loading: boolean;
  pageIndicator: string;
  isFirstPage: boolean;
}

interface DukeTablePageSnapshot {
  fingerprint: string;
  paginationRange: string;
  currentPage: number | null;
  totalPages: number | null;
  realRowCount: number;
  firstRowUniqueKey: string | null;
  lastRowUniqueKey: string | null;
  firstBillingCycleStart: string | null;
  lastBillingCycleStart: string | null;
  emptyMessage: string | null;
}

interface DukeRealBillRow {
  accountNumber: string;
  billingCycle: string;
  billingCycleStart: Date;
  uniqueKey: string;
}

interface PartnerSwitchActivity {
  sawRequestOrNavigation: boolean;
  stop(): void;
}

type PaginationControl = 'first' | 'previous' | 'next';

export class DukePortal implements BillingPortal {
  public readonly name = 'duke';

  private currentTablePage: number | undefined;

  private billingCycleSortDirection: DukeSortDirection = 'unknown';

  private selectedBatchKeys = new Set<string>();

  private expectedBatchKeys = new Set<string>();

  public constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly credentials: DukeCredentials,
    private readonly config: DukeConfig,
    private readonly logger: Logger,
  ) {
    page.setDefaultTimeout(config.actionTimeoutMs);
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  }

  public async login(): Promise<void> {
    try {
      await this.page.goto(this.config.homeUrl, { waitUntil: 'domcontentloaded' });

      const signInRegister = await this.waitForPreferredVisibleLocator(
        [
          this.page.getByRole('link', { name: dukeAccessibleNames.signInRegister }),
          this.page.getByRole('button', { name: dukeAccessibleNames.signInRegister }),
          this.page.getByText(dukeAccessibleNames.signInRegister),
        ],
        'Duke Sign In / Register action',
      );
      await signInRegister.click();

      const username = await this.waitForPreferredVisibleLocator(
        [
          this.page.getByLabel(dukeAccessibleNames.usernameField),
          this.page.getByPlaceholder(dukeAccessibleNames.usernameField),
          this.page.locator(dukeSelectors.usernameInput),
        ],
        'Duke username field',
      );
      const password = this.page
        .getByLabel(dukeAccessibleNames.passwordField)
        .or(this.page.getByPlaceholder(dukeAccessibleNames.passwordField))
        .or(this.page.locator(dukeSelectors.passwordInput))
        .filter({ visible: true })
        .first();

      await username.fill(this.credentials.username);

      // Duke may use a two-step sign-in form: username first, password after
      // Continue. On the combined form, the password is already visible and
      // this branch simply proceeds to the final submit action.
      try {
        await password.waitFor({ state: 'visible', timeout: 2_000 });
      } catch {
        const continueAction = await this.waitForPreferredVisibleLocator(
          [
            this.page.getByRole('button', { name: dukeAccessibleNames.loginSubmit }),
            this.page.getByRole('link', { name: dukeAccessibleNames.loginSubmit }),
            this.page.locator(dukeSelectors.loginSubmit),
          ],
          'Duke username-step continue action',
        );
        await continueAction.click();
        await password.waitFor({
          state: 'visible',
          timeout: this.config.navigationTimeoutMs,
        });
      }

      await password.fill(this.credentials.password);

      const submit = await this.waitForPreferredVisibleLocator(
        [
          this.page.getByRole('button', { name: dukeAccessibleNames.loginSubmit }),
          this.page.locator(dukeSelectors.loginSubmit),
        ],
        'Duke login submit action',
      );
      await submit.click();

      const outcomeValue = await this.resolveLoginOutcome();

      if (outcomeValue === 'error') {
        throw new Error(await this.classifyLoginFailure());
      }
      if (outcomeValue === 'challenge') {
        throw new Error(
          'Duke login requires an interactive verification, MFA, terms, or password-reset step that this adapter does not automate.',
        );
      }
      if (outcomeValue === 'unknown') {
        throw new Error(
          'Duke login completion could not be verified. A screenshot (duke-login-failure.png) and the current page text were logged. Check the live login-success selector and whether Duke requires a Business/Residential choice, MFA, terms acceptance, or a password reset.',
        );
      }
    } catch (error) {
      throw this.portalError('login', errorMessage(error), {}, error);
    }
  }

  public async navigateToBills(): Promise<void> {
    try {
      this.logger.info(`Navigating directly to Duke business billing history: ${this.config.businessBillsUrl}`);
      await this.page.goto(this.config.businessBillsUrl, { waitUntil: 'domcontentloaded' });
      this.logger.info(`Duke billing page loaded: ${this.page.url()}`);
      // Wait for either the billing table or a redirect back to login. We avoid
      // page.waitForFunction because esbuild's keepNames transform wraps the
      // serialized function with an undefined __name() helper in the browser.
      const tableLocator = this.billingTable();
      const passwordLocator = this.page
        .locator(dukeSelectors.passwordInput)
        .filter({ visible: true })
        .first();
      const errorLocator = this.page
        .locator(dukeSelectors.loginError)
        .filter({ visible: true })
        .first();

      const deadline = Date.now() + this.config.navigationTimeoutMs;
      let sawLogin = false;
      while (Date.now() < deadline) {
        if ((await tableLocator.count()) > 0 && (await tableLocator.isVisible())) {
          await this.waitForBillingTableReady();
          await this.goToFirstTablePage();
          await this.assertBillingTableReadyOnFirstPage();
          return;
        }
        if (
          ((await passwordLocator.count()) > 0 && (await passwordLocator.isVisible())) ||
          ((await errorLocator.count()) > 0 && (await errorLocator.isVisible()))
        ) {
          sawLogin = true;
          break;
        }
        await this.page.waitForTimeout(500);
      }

      if (sawLogin) {
        throw new Error('Duke redirected back to login; the authenticated session was not established.');
      }
      throw new Error('Duke billing table did not appear after navigation.');
    } catch (error) {
      throw this.portalError('navigate to billing table', errorMessage(error), {}, error);
    }
  }

  public async listAccounts(): Promise<PortalAccount[]> {
    try {
      const menu = await this.openBusinessPartnerMenu();
      const accounts = new Map<string, PortalAccount>();
      let stagnantPasses = 0;
      for (let pass = 0; pass < 1_000 && stagnantPasses < 3; pass += 1) {
        const beforeCount = accounts.size;
        const options = menu.locator(dukeSelectors.businessPartnerOption).filter({ visible: true });
        const optionCount = await options.count();
        for (let index = 0; index < optionCount; index += 1) {
          const account = await this.readBusinessPartnerOption(options.nth(index));
          const existing = accounts.get(account.id);
          accounts.set(account.id, {
            ...account,
            isCurrent: account.isCurrent || existing?.isCurrent === true,
          });
        }
        stagnantPasses = accounts.size === beforeCount ? stagnantPasses + 1 : 0;
        await menu.hover();
        await this.page.mouse.wheel(0, 800);
        await this.page.waitForTimeout(250);
      }
      await this.closeBusinessPartnerMenu();
      if (accounts.size === 0) {
        throw new Error('No Business Partner options were found. Verify the live Duke account-selector locators.');
      }
      if (![...accounts.values()].some((account) => account.isCurrent)) {
        throw new Error('Duke Business Partner menu did not identify a current account.');
      }
      return [...accounts.values()];
    } catch (error) {
      await this.closeBusinessPartnerMenu().catch(() => undefined);
      throw this.portalError('list Business Partner accounts', errorMessage(error), {}, error);
    }
  }

  public async activateAccount(account: PortalAccount): Promise<void> {
    try {
      const before = await this.billingTableReadiness().catch(() => null);
      this.logger.info(
        `[portal=${this.name} account=${account.id}] Before switch table fingerprint: ${before?.fingerprint ?? 'unavailable'}.`,
      );
      const menu = await this.openBusinessPartnerMenu();
      const switchActivity = this.observePartnerSwitchActivity();
      let target: Locator | undefined;
      let stagnantPasses = 0;
      for (let pass = 0; pass < 1_000 && stagnantPasses < 3; pass += 1) {
        const options = menu.locator(dukeSelectors.businessPartnerOption).filter({ visible: true });
        const optionCount = await options.count();
        for (let index = 0; index < optionCount; index += 1) {
          const option = options.nth(index);
          const candidate = await this.readBusinessPartnerOption(option);
          if (candidate.id === account.id) {
            target = option;
            break;
          }
        }
        if (target) break;
        stagnantPasses += 1;
        await menu.hover();
        await this.page.mouse.wheel(0, 800);
        await this.page.waitForTimeout(250);
      }
      if (!target) {
        throw new Error(`Business Partner account ${account.id} was not found while activating it.`);
      }

      // Selecting a Business Partner on the live portal closes or re-renders
      // this menu immediately. Do not continue iterating its old row locators;
      // click only the target's checkbox and let Duke make that account active.
      const checkbox = target.locator(dukeSelectors.businessPartnerOptionCheckbox).first();
      try {
        if (!(await this.isBusinessPartnerOptionChecked(checkbox))) {
          await checkbox.click();
        }
        await this.closeBusinessPartnerMenu();
        const control = await this.businessPartnerControl();
        const deadline = Date.now() + this.config.actionTimeoutMs;
        while (Date.now() < deadline) {
          const text = (await control.innerText().catch(() => '')).replace(/\s+/gu, ' ');
          if (text.includes(account.id)) break;
          await this.page.waitForTimeout(250);
        }
        const currentText = (await control.innerText().catch(() => '')).replace(/\s+/gu, ' ');
        if (!currentText.includes(account.id)) {
          throw new Error(`Duke did not show Business Partner ${account.id} as the active selector value.`);
        }
        this.logger.info(`[portal=${this.name} account=${account.id}] Confirmed selector value: ${account.id}.`);
        await this.waitForBillingTableReady(account, before?.fingerprint, switchActivity);
        await this.goToFirstTablePage();
        const after = await this.assertBillingTableReadyOnFirstPage(account);
        this.logger.info(
          `[portal=${this.name} account=${account.id}] After switch table fingerprint: ${after.fingerprint}; realRows=${after.realRowCount}; page="${after.pageIndicator || 'unknown'}".`,
        );
      } finally {
        switchActivity.stop();
      }
    } catch (error) {
      await this.closeBusinessPartnerMenu().catch(() => undefined);
      throw this.portalError('activate Business Partner account', errorMessage(error), { account: account.id }, error);
    }
  }

  private async readBusinessPartnerOption(option: Locator): Promise<PortalAccount> {
    const checkbox = option.locator(dukeSelectors.businessPartnerOptionCheckbox).first();
    const [text, optionValue, dataAccountId, checkboxValue, checkboxDataAccountId] = await Promise.all([
      option.innerText(),
      option.getAttribute('value'),
      option.getAttribute('data-account-id'),
      checkbox.getAttribute('value').catch(() => null),
      checkbox.getAttribute('data-account-id').catch(() => null),
    ]);
    return toDukePortalAccount({
      text,
      value: checkboxValue ?? optionValue,
      dataAccountId: checkboxDataAccountId ?? dataAccountId,
      isCurrent: await this.isBusinessPartnerOptionChecked(checkbox),
    });
  }

  private async isBusinessPartnerOptionChecked(checkbox: Locator): Promise<boolean> {
    if ((await checkbox.count()) === 0) {
      throw new Error('Business Partner option has no checkbox-like control.');
    }
    const ariaChecked = await checkbox.getAttribute('aria-checked');
    if (ariaChecked !== null) return ariaChecked === 'true';
    return checkbox.isChecked();
  }

  private async businessPartnerControl(): Promise<Locator> {
    return this.waitForPreferredVisibleLocator(
      [
        this.page.getByLabel(dukeAccessibleNames.businessPartner),
        this.page.getByRole('button', { name: dukeAccessibleNames.businessPartner }),
        this.page.locator(dukeSelectors.businessPartnerSelector),
        // The live Business Portal displays "Business Partner" as a separate
        // text label above the actual dropdown. Its control therefore has no
        // matching accessible name; find the first interactive sibling that
        // follows that exact visible label.
        this.page
          .getByText('Business Partner', { exact: true })
          .locator('xpath=following::*[self::button or self::input or self::select or @role="combobox"][1]'),
      ],
      'Duke Business Partner selector',
    );
  }

  private async openBusinessPartnerMenu(): Promise<Locator> {
    const control = await this.businessPartnerControl();
    await control.click();
    return this.waitForPreferredVisibleLocator(
      [this.page.locator(dukeSelectors.businessPartnerMenu)],
      'Duke Business Partner menu',
    );
  }

  private async closeBusinessPartnerMenu(): Promise<void> {
    const menu = this.page.locator(dukeSelectors.businessPartnerMenu).filter({ visible: true }).first();
    if ((await menu.count()) === 0) return;
    await this.page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden', timeout: this.config.actionTimeoutMs }).catch(() => undefined);
  }

  /**
   * Waits for the post-credentials state and resolves it. Duke may present an
   * intermediate Business/Residential experience choice before the dashboard,
   * so we handle that here and then re-check for success/error/challenge.
   */
  private async resolveLoginOutcome(): Promise<'success' | 'error' | 'challenge' | 'unknown'> {
    const errorLocator = this.page
      .locator(dukeSelectors.loginError)
      .filter({ visible: true })
      .first();
    const challengeLocator = this.page
      .locator(dukeSelectors.loginChallenge)
      .filter({ visible: true })
      .first();
    const successLocator = this.page
      .locator(dukeSelectors.loginSuccess)
      .filter({ visible: true })
      .first();
    const businessChoice = this.page
      .getByText('Business', { exact: true })
      .filter({ visible: true })
      .first();

    const deadline = Date.now() + this.config.navigationTimeoutMs;
    while (Date.now() < deadline) {
      // NOTE: we deliberately avoid page.evaluate/waitForFunction here. esbuild's
      // keepNames transform wraps every serialized function with a __name()
      // helper that is undefined inside the browser, throwing
      // "ReferenceError: __name is not defined". Locators run in Node instead.
      if ((await errorLocator.count()) > 0 && (await errorLocator.isVisible())) {
        const text = (await errorLocator.innerText().catch(() => '')).trim();
        if (text.length > 0) return 'error';
      }
      if ((await challengeLocator.count()) > 0 && (await challengeLocator.isVisible())) {
        return 'challenge';
      }
      // Intermediate step: Duke may ask the user to pick Business or
      // Residential after submitting credentials. Click Business before
      // treating the login as complete.
      if (await businessChoice.isVisible().catch(() => false)) {
        this.logger.info('Selecting Duke Business experience after login');
        await businessChoice.click();
        continue;
      }
      // The Business experience redirects to its dashboard after the
      // Business choice. That page does not expose the residential login
      // success markers, so recognize the authenticated dashboard by URL.
      if (this.isBusinessDashboardUrl()) {
        return 'success';
      }
      if ((await successLocator.count()) > 0 && (await successLocator.isVisible())) {
        return 'success';
      }

      await this.page.waitForTimeout(1_000);
    }

    // Diagnostics so the failure is actionable against the live site.
    const url = this.page.url();
    const bodyText = (await this.page.locator('body').innerText()).slice(0, 1_000);
    this.logger.error(`Login verification timed out. URL: ${url}`);
    this.logger.error(`Visible page text (first 1000 chars):\n${bodyText}`);
    try {
      const screenshotPath = 'duke-login-failure.png';
      await this.page.screenshot({ path: screenshotPath, fullPage: false });
      this.logger.error(`Saved login-failure screenshot to ${screenshotPath}`);
    } catch {
      // Screenshot is best-effort; ignore if it fails.
    }
    return 'unknown';
  }

  private isBusinessDashboardUrl(): boolean {
    try {
      const currentUrl = new URL(this.page.url());
      const businessBillsUrl = new URL(this.config.businessBillsUrl);
      return (
        currentUrl.origin === businessBillsUrl.origin &&
        currentUrl.pathname.toLowerCase().endsWith('/businessdashboard')
      );
    } catch {
      return false;
    }
  }

  public async scanBills(requestedStart: Date, requestedEnd: Date): Promise<Bill[]> {
    const matches: Bill[] = [];
    const seenKeys = new Set<string>();

    await this.traverseDescendingBillingCyclePages(async (pageNumber) => {
      this.logger.info(
        `Scanning billing-table page ${pageNumber} (safety limit: ${this.config.maximumTablePages}).`,
      );
      const columns = await this.readColumnMap();
      const rows = this.tableRows();
      const rowCount = await rows.count();

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row = rows.nth(rowIndex);
        if (!(await row.isVisible())) continue;
        const parsed = await this.tryParseBillRow(row, columns, 'scan');
        if (!parsed) continue;
        const cycleStart = parseIsoDate(parsed.bill.billingCycleStart, 'billing cycle start');
        const scanDecision = classifyDukeBillForDiscovery(
          cycleStart,
          requestedStart,
          requestedEnd,
          parsed.pdfLink !== null,
        );
        if (scanDecision === 'skip-newer') continue;
        if (scanDecision === 'stop-before-start') {
          this.logger.info(
            `[portal=${this.name} page=${pageNumber}] Reached billing-cycle start ${parsed.bill.billingCycleStart} before requested start ${this.formatDateForLog(requestedStart)}; startDateBoundaryReached=true; stopping this Business Partner scan.`,
          );
          return true;
        }
        if (scanDecision === 'include-unavailable') {
          this.logger.warn(
            `[portal=${this.name} page=${pageNumber}] Eligible bill is unavailable because it has no View Bill action: key=${parsed.bill.uniqueKey} account=${parsed.bill.accountNumber} billingCycle=${parsed.bill.billingCycleStart}-to-${parsed.bill.billingCycleEnd}`,
          );
          continue;
        }
        if (seenKeys.has(parsed.bill.uniqueKey)) continue;
        seenKeys.add(parsed.bill.uniqueKey);

        if (isBillingCycleStartInRange(cycleStart, requestedStart, requestedEnd)) {
          matches.push(parsed.bill);
        }
      }
    });

    return matches;
  }

  /** Finds requested accounts whose billing cycle starts in the requested month. */
  public async scanBillsForTargetStartMonth(
    targetAccountNumbers: ReadonlySet<string>,
    billingStartMonth: Date,
    onMatch?: (bill: Bill) => Promise<void>,
  ): Promise<Bill[]> {
    if (targetAccountNumbers.size === 0) return [];
    const remaining = new Set([...targetAccountNumbers].map(normalizeAccountNumber));
    const matches: Bill[] = [];

    await this.traverseDescendingBillingCyclePages(async (pageNumber) => {
      const columns = await this.readColumnMap();
      const rows = this.tableRows();
      const rowCount = await rows.count();
      const pageMatches: Bill[] = [];
      let parsedBillRows = 0;
      let startMonthRows = 0;
      let targetAccountRows = 0;
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row = rows.nth(rowIndex);
        if (!(await row.isVisible())) continue;
        const parsed = await this.tryParseBillRow(row, columns, 'target-start-month scan');
        if (!parsed) continue;
        parsedBillRows += 1;
        const cycleStart = parseIsoDate(parsed.bill.billingCycleStart, 'billing cycle start');
        if (cycleStart.getTime() > endOfMonth(billingStartMonth).getTime()) continue;
        if (cycleStart.getTime() < billingStartMonth.getTime()) {
          this.logger.info(
            `[portal=${this.name} page=${pageNumber}] Reached billing cycles before ${this.formatDateForLog(billingStartMonth)}; stopping target-start-month scan.`,
          );
          return true;
        }
        startMonthRows += 1;
        const accountNumber = normalizeAccountNumber(parsed.bill.accountNumber);
        if (!remaining.has(accountNumber)) continue;
        targetAccountRows += 1;
        if (parsed.pdfLink === null) {
          this.logger.warn(
            `[portal=${this.name} page=${pageNumber}] Target-start-month bill has no View Bill action for account ${parsed.bill.accountNumber}.`,
          );
          continue;
        }
        remaining.delete(accountNumber);
        matches.push(parsed.bill);
        pageMatches.push(parsed.bill);
        this.logger.info(
          `[portal=${this.name} page=${pageNumber}] Target-start-month bill found: account=${parsed.bill.accountNumber} billingCycle=${parsed.bill.billingCycleStart}-to-${parsed.bill.billingCycleEnd}.`,
        );
      }
      for (const bill of pageMatches) {
        await onMatch?.(bill);
      }
      this.logger.info(
        `[portal=${this.name} page=${pageNumber}] Target scan page summary: visibleRows=${rowCount} parsedBillRows=${parsedBillRows} startMonthRows=${startMonthRows} targetAccountRows=${targetAccountRows} downloadableMatches=${pageMatches.length} remainingTargets=${remaining.size}.`,
      );
      return remaining.size === 0;
    });

    return matches;
  }

  /** Downloads a target bill directly from the row found on the current scan page. */
  public async downloadTargetBill(
    bill: Bill,
    batchNumber: number,
    outputPath: string,
  ): Promise<string> {
    let parsed = await this.findBillOnCurrentPage(bill, 'target download');
    if (!parsed) {
      throw this.portalError(
        'download target bill',
        `Bill ${bill.uniqueKey} was not found on the current billing-table page.`,
        { batch: batchNumber },
      );
    }
    if (parsed.pdfLink === null) {
      throw this.portalError(
        'download target bill',
        `Bill ${bill.uniqueKey} has no View Bill action on the live portal.`,
        { batch: batchNumber },
      );
    }

    const pageNumber = this.currentTablePage ?? 'unknown';
    this.logger.info(
      `[portal=${this.name} page=${pageNumber} batch=${batchNumber}] Downloading matched bill immediately from the current row: key=${bill.uniqueKey}.`,
    );
    try {
      const downloadedPath = await downloadDukePdf({
        page: this.page,
        context: this.context,
        printAction: parsed.pdfLink,
        outputPath,
        timeoutMs: this.config.downloadTimeoutMs,
        responseUrlHints: dukeSelectors.pdfResponseUrlHints,
        onCapture: (source) => {
          this.logger.info(
            `[portal=${this.name} page=${pageNumber} batch=${batchNumber}] Matched bill PDF ${source} detected for key=${bill.uniqueKey}.`,
          );
        },
      });
      this.logger.info(
        `[portal=${this.name} page=${pageNumber} batch=${batchNumber}] Immediate matched-bill download completed: ${downloadedPath}.`,
      );
      return downloadedPath;
    } catch (error) {
      if (!(error instanceof DukeSessionExpiredError)) throw error;
      this.logger.warn(
        `[portal=${this.name} page=${pageNumber} batch=${batchNumber}] Duke session expired during immediate matched-bill download; re-authenticating and retrying.`,
      );
      await this.recoverSession();
      parsed = await this.findBillOnCurrentPage(bill, 'target download after session recovery');
      if (!parsed?.pdfLink) {
        throw this.portalError(
          'download target bill',
          `Bill ${bill.uniqueKey} did not expose a View Bill action after session recovery.`,
          { batch: batchNumber },
        );
      }
      return downloadDukePdf({
        page: this.page,
        context: this.context,
        printAction: parsed.pdfLink,
        outputPath,
        timeoutMs: this.config.downloadTimeoutMs,
        responseUrlHints: dukeSelectors.pdfResponseUrlHints,
        onCapture: (source) => {
          this.logger.info(
            `[portal=${this.name} batch=${batchNumber}] Recovered-session matched bill PDF ${source} detected for key=${bill.uniqueKey}.`,
          );
        },
      });
    }
  }

  public async selectBatch(
    bills: Bill[],
    requestedStart: Date,
    requestedEnd: Date,
  ): Promise<void> {
    if (bills.length === 0 || bills.length > 25) {
      throw this.portalError(
        'select batch',
        `Expected 1 to 25 bills but received ${bills.length}.`,
      );
    }

    const targets = new Map(bills.map((bill) => [bill.uniqueKey, bill]));
    const tracker = new DukeBatchSelectionTracker(bills.map((bill) => bill.uniqueKey));
    this.expectedBatchKeys = new Set(bills.map((bill) => bill.uniqueKey));
    for (const bill of bills) {
      if (
        !isBillingCycleStartInRange(
          parseIsoDate(bill.billingCycleStart, 'billing cycle start'),
          requestedStart,
          requestedEnd,
        )
      ) {
        throw this.portalError(
          'select batch',
          'The requested batch contains a bill outside the requested billing-cycle start-date range.',
          {
            account: bill.accountNumber,
            billingCycle: `${bill.billingCycleStart}-to-${bill.billingCycleEnd}`,
          },
        );
      }
    }

    await this.traverseDescendingBillingCyclePages(async (pageNumber) => {
      tracker.visitPage(pageNumber);
      // Checking a row can re-render Duke's table. Restart this page's scan
      // after every check so every Locator is acquired from the current DOM.
      let reacquireRows = true;
      while (reacquireRows) {
        reacquireRows = false;
        const columns = await this.readColumnMap();
        const rows = this.tableRows();
        const rowCount = await rows.count();

        for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
          const row = rows.nth(rowIndex);
          if (!(await row.isVisible())) continue;
          const parsed = await this.tryParseBillRow(row, columns, 'selection');
          if (!parsed) continue;
          const cycleStart = parseIsoDate(parsed.bill.billingCycleStart, 'billing cycle start');
          const scanDecision = classifyDukeBillingCycleStart(cycleStart, requestedStart, requestedEnd);
          if (scanDecision === 'skip-newer') continue;
          if (scanDecision === 'stop-before-start') {
            this.logger.info(
              `[portal=${this.name} page=${pageNumber}] Reached billing-cycle start ${parsed.bill.billingCycleStart} before requested start ${this.formatDateForLog(requestedStart)}; startDateBoundaryReached=true; stopping selection scan.`,
            );
            return true;
          }
          const target = targets.get(parsed.bill.uniqueKey);
          if (!target) {
            if (await parsed.checkbox.isChecked()) {
              throw this.portalError(
                'select batch',
                'A non-target bill is selected; stale selections were not cleared.',
                { account: parsed.bill.accountNumber, billingCycle: `${parsed.bill.billingCycleStart}-to-${parsed.bill.billingCycleEnd}` },
              );
            }
            continue;
          }
          if (tracker.summary().selectedKeys.includes(parsed.bill.uniqueKey)) continue;
          if (parsed.pdfLink === null) {
            tracker.markUnavailable(parsed.bill.uniqueKey);
            this.logger.warn(`[portal=${this.name} page=${pageNumber}] Eligible batch bill is unavailable because it has no View Bill action: key=${parsed.bill.uniqueKey}`);
            continue;
          }
          if (!(await parsed.checkbox.isChecked())) await parsed.checkbox.check();
          if (!(await parsed.checkbox.isChecked())) {
            throw this.portalError('select batch', 'The target checkbox did not remain selected.', {
              account: target.accountNumber,
              billingCycle: `${target.billingCycleStart}-to-${target.billingCycleEnd}`,
            });
          }
          tracker.markSelected(parsed.bill.uniqueKey);
          this.logger.info(`[portal=${this.name} page=${pageNumber}] Selected bill: key=${parsed.bill.uniqueKey}`);
          // Do not use the row/checkbox Locator after this point: Duke may
          // replace the full table as soon as selection changes.
          reacquireRows = true;
          break;
        }
      }
      return tracker.allExpectedSelectableBillsAreSelected();
    });
    const summary = tracker.summary();
    this.logger.info(
      `[portal=${this.name}] Duke bulk batch selection: expected=${summary.expectedKeys.length} selectable=${summary.expectedSelectableKeys.length} selected=${summary.selectedKeys.length} pagesVisited=${summary.pagesVisited.join(',') || 'none'} selectedKeys=${summary.selectedKeys.join(',') || 'none'} missingKeys=${summary.missingKeys.join(',') || 'none'} unavailableKeys=${summary.unavailableKeys.join(',') || 'none'}.`,
    );
    if (summary.unavailableKeys.length > 0 || summary.missingKeys.length > 0) {
      throw this.portalError(
        'select batch',
        `Selected ${summary.selectedKeys.length} of ${summary.expectedSelectableKeys.length} selectable bills. Missing keys: ${summary.missingKeys.join(',') || 'none'}. Unavailable keys: ${summary.unavailableKeys.join(',') || 'none'}.`,
      );
    }
    if (summary.selectedKeys.length !== summary.expectedSelectableKeys.length) {
      throw this.portalError('select batch', 'Selected-count does not match expected selectable bill count.');
    }
    await this.verifySelectionCount(summary.expectedSelectableKeys.length);
    this.selectedBatchKeys = new Set(summary.selectedKeys);
  }

  public async downloadSelectedBatch(
    batchNumber: number,
    outputPath: string,
    expectedBillCount: number,
    _requestedStart: Date,
    _requestedEnd: Date,
  ): Promise<string> {
    try {
      await this.verifySelectionCount(expectedBillCount);
      // The live Duke Business Portal exposes no bulk "Print Bills" action; it
      // renders a per-row "View Bill" link in the ACTIONS column. We download
      // each selected bill individually through that link and merge the
      // captured PDFs into the requested batch output.
      const expectedKeys = [...this.expectedBatchKeys];
      if (expectedKeys.length !== expectedBillCount) {
        throw this.portalError(
          'download selected batch',
          `Expected ${expectedBillCount} selected bill(s) but the batch keys contain ${expectedKeys.length}.`,
          { batch: batchNumber },
        );
      }

      const stagingPaths: string[] = [];
      let captured = 0;
      for (const key of expectedKeys) {
        const pdfPath = await this.downloadBillByKey(key, batchNumber);
        stagingPaths.push(pdfPath);
        captured += 1;
      }

      if (captured !== expectedBillCount) {
        throw this.portalError(
          'download selected batch',
          `Captured ${captured} of ${expectedBillCount} expected bill PDF(s).`,
          { batch: batchNumber },
        );
      }

      if (stagingPaths.length === 1) {
        await rename(stagingPaths[0]!, outputPath);
      } else {
        await mergePdfs(stagingPaths, outputPath);
        for (const stagingPath of stagingPaths) {
          await rm(stagingPath, { force: true }).catch(() => undefined);
        }
      }
      this.logger.info(
        `[portal=${this.name} batch=${batchNumber}] Downloaded ${captured} bill PDF(s) into ${outputPath}`,
      );
      return outputPath;
    } catch (error) {
      try {
        await this.restoreBillingTableAfterDownload();
      } catch (restoreError) {
        throw this.portalError(
          'download selected batch',
          `${errorMessage(error)} The billing table also could not be restored: ${errorMessage(restoreError)}`,
          { batch: batchNumber },
          error,
        );
      }
      throw this.portalError(
        'download selected batch',
        errorMessage(error),
        { batch: batchNumber },
        error,
      );
    }
  }

  /**
   * Navigates to the row for the given bill key, clicks its "View Bill" link,
   * and captures the resulting PDF. The selection checkbox is not required for
   * the per-row action, but we keep the selection intact so callers can still
   * verify the selected-account count afterward.
   */
  private async downloadBillByKey(key: string, batchNumber: number): Promise<string> {
    const stagingPath = `${this.config.tempDirectory ?? '.'}/${this.name}-bill-${createHash('sha256').update(key).digest('hex').slice(0, 16)}.${process.pid}.${Date.now()}.pdf`;
    let found = false;
    await this.traverseDescendingBillingCyclePages(async (pageNumber) => {
      const columns = await this.readColumnMap();
      const rows = this.tableRows();
      const rowCount = await rows.count();
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row = rows.nth(rowIndex);
        if (!(await row.isVisible())) continue;
        const parsed = await this.tryParseBillRow(row, columns, 'download');
        if (!parsed) continue;
        if (parsed.bill.uniqueKey !== key) continue;
        if (parsed.pdfLink === null) {
          throw this.portalError(
            'download selected batch',
            `Bill ${key} has no View Bill action on the live portal.`,
            { batch: batchNumber, page: pageNumber },
          );
        }
        this.logger.info(
          `[portal=${this.name} page=${pageNumber} batch=${batchNumber}] Clicking View Bill for key=${key}.`,
        );
        let downloadedPath: string;
        try {
          downloadedPath = await downloadDukePdf({
            page: this.page,
            context: this.context,
            printAction: parsed.pdfLink,
            outputPath: stagingPath,
            timeoutMs: this.config.downloadTimeoutMs,
            responseUrlHints: dukeSelectors.pdfResponseUrlHints,
            onCapture: (source) => {
              this.logger.info(
                `[portal=${this.name} page=${pageNumber} batch=${batchNumber}] View Bill PDF ${source} detected for key=${key}.`,
              );
            },
          });
        } catch (error) {
          // Duke returned an HTML login/error page instead of a PDF: the
          // authenticated session was invalidated (expired or rate-limited)
          // after many rapid downloads. Re-authenticate and retry the same
          // bill once rather than failing the whole run.
          if (error instanceof DukeSessionExpiredError) {
            this.logger.warn(
              `[portal=${this.name} page=${pageNumber} batch=${batchNumber}] ${errorMessage(error)} Re-authenticating and retrying key=${key}.`,
            );
            await this.recoverSession();
            downloadedPath = await downloadDukePdf({
              page: this.page,
              context: this.context,
              printAction: parsed.pdfLink,
              outputPath: stagingPath,
              timeoutMs: this.config.downloadTimeoutMs,
              responseUrlHints: dukeSelectors.pdfResponseUrlHints,
              onCapture: (source) => {
                this.logger.info(
                  `[portal=${this.name} page=${pageNumber} batch=${batchNumber}] View Bill PDF ${source} detected for key=${key} (post-recovery).`,
                );
              },
            });
          } else {
            throw error;
          }
        }
        this.logger.info(
          `[portal=${this.name} page=${pageNumber} batch=${batchNumber}] View Bill completed: saved PDF path=${downloadedPath} for key=${key}`,
        );
        found = true;
        return true;
      }
      return false;
    });

    if (!found) {
      throw this.portalError(
        'download selected batch',
        `Bill ${key} was not found on any billing-table page during download.`,
        { batch: batchNumber },
      );
    }
    return stagingPath;
  }

  /**
   * Re-establishes the authenticated Duke session after it was invalidated
   * mid-run (typically after many rapid bill downloads). Re-logs in and
   * re-navigates to the billing table so a subsequent download attempt starts
   * from a fresh, valid session.
   */
  private async recoverSession(): Promise<void> {
    this.logger.info(`[portal=${this.name}] Session recovery: re-authenticating and reloading the billing table.`);
    try {
      await this.login();
      await this.navigateToBills();
    } catch (error) {
      throw this.portalError(
        'recover session',
        `Re-authentication failed after the Duke session was invalidated: ${errorMessage(error)}`,
        {},
        error,
      );
    }
  }

  public async clearSelections(): Promise<void> {
    const currentCount = await this.readSelectedCount();
    if (currentCount === 0) {
      this.selectedBatchKeys.clear();
      this.expectedBatchKeys.clear();
      return;
    }

    const clearControl = await this.preferredExistingLocator([
      this.page.getByRole('button', { name: dukeAccessibleNames.clearSelections }),
      this.page.getByRole('link', { name: dukeAccessibleNames.clearSelections }),
      this.page.locator(dukeSelectors.clearSelectionsButton),
    ]);

    if ((await clearControl.count()) === 0 || !(await this.controlIsEnabled(clearControl))) {
      // Duke hides the global action for small selections (including the
      // one-bill selections used by targeted runs). Uncheck selected rows
      // directly instead of treating that UI detail as a fatal state.
      await this.clearCheckedRowsAcrossPages();
      await this.verifySelectionCount(0);
      this.selectedBatchKeys.clear();
      this.expectedBatchKeys.clear();
      this.logger.info(`[portal=${this.name}] Cleared the current batch selection by unchecking selected rows; selected-count=0.`);
      return;
    }
    await clearControl.click();
    const confirm = await this.preferredExistingLocator([
      this.page
        .getByRole('dialog')
        .getByRole('button', { name: dukeAccessibleNames.confirmClearSelections }),
      this.page.locator(dukeSelectors.confirmClearSelectionsButton),
    ]);
    if ((await confirm.count()) > 0 && (await confirm.isVisible())) await confirm.click();
    await this.verifySelectionCount(0);
    this.selectedBatchKeys.clear();
    this.expectedBatchKeys.clear();
    this.logger.info(`[portal=${this.name}] Cleared the current batch selection; selected-count=0.`);
  }

  public async verifySelectionCount(expectedCount: number): Promise<void> {
    const immediateCount = await this.readSelectedCount();
    if (immediateCount === null) {
      const checkedRows = await this.countCheckedRowsAcrossPages();
      if (checkedRows === expectedCount) return;
      if (expectedCount === 0) {
        throw this.portalError(
          'verify selection count',
          `The selected-account counter is unavailable and ${checkedRows} checked row(s) remain; expected 0.`,
        );
      }
      throw this.portalError(
        'verify selection count',
        `The selected-account counter is unavailable and ${checkedRows} checked row(s) remain; expected ${expectedCount}.`,
      );
    }

    try {
      // Poll readSelectedCount instead of page.waitForFunction: esbuild's
      // keepNames transform wraps the serialized function with an undefined
      // __name() helper in the browser.
      const deadline = Date.now() + this.config.actionTimeoutMs;
      let matched = false;
      while (Date.now() < deadline) {
        const actual = await this.readSelectedCount();
        if (actual === expectedCount) {
          matched = true;
          break;
        }
        await this.page.waitForTimeout(500);
      }
      if (!matched) {
        throw new Error('Duke selected-account count did not reach the expected value.');
      }
    } catch (error) {
      const actual = await this.readSelectedCount();
      throw this.portalError(
        'verify selection count',
        actual === null
          ? `Duke selected-account count control was not found; expected ${expectedCount}.`
          : `Duke reports ${actual} selected account(s); expected ${expectedCount}.`,
        {},
        error,
      );
    }

    const actual = await this.readSelectedCount();
    if (actual === null && expectedCount === 0) {
      const checkedRows = await this.countCheckedRowsAcrossPages();
      if (checkedRows === 0) return;
      throw this.portalError(
        'verify selection count',
        `The selected-account counter disappeared but ${checkedRows} checked row(s) remain; expected 0.`,
      );
    }
    if (actual === null) {
      throw this.portalError(
        'verify selection count',
        `Duke selected-account count control was not found; expected ${expectedCount}.`,
      );
    }
    if (actual !== expectedCount) {
      throw this.portalError(
        'verify selection count',
        `Duke reports ${actual} selected account(s); expected ${expectedCount}.`,
      );
    }
  }

  /**
   * Duke billing history must be scanned newest-first. The callback is only
   * allowed to stop on the requested-start boundary after this method has
   * verified both the portal's sort indicator and the displayed row order.
   */
  private async traverseDescendingBillingCyclePages(
    visit: (pageNumber: number) => Promise<boolean | void>,
  ): Promise<void> {
    await this.goToFirstTablePage();
    await this.ensureBillingCycleDescending();

    await this.traverseTablePages(async (pageNumber) => {
      await this.assertDisplayedBillingCyclesDescending();
      return visit(pageNumber);
    });

  }

  private async ensureBillingCycleDescending(): Promise<void> {
    const columns = await this.readColumnMap();
    const header = this.billingTable().locator(dukeSelectors.tableHeaders).nth(columns.billingCycle);
    let direction = await this.readBillingCycleSortDirection(header);
    this.billingCycleSortDirection = direction;
    if (!shouldClickForDescendingBillingCycleSort(direction)) {
      await this.assertDisplayedBillingCyclesDescending();
      this.logger.info(`[portal=${this.name}] Billing Cycle sort is confirmed descending; no header click needed.`);
      return;
    }

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const before = await this.tablePageSnapshot();
      this.logger.info(
        `[portal=${this.name}] Billing Cycle sort is ${direction}; clicking header to request descending order (attempt ${attempt}/2).`,
      );
      await header.click();
      direction = await this.waitForBillingCycleDescendingSort(header, before);
      this.billingCycleSortDirection = direction;
      if (direction === 'descending') {
        await this.assertDisplayedBillingCyclesDescending();
        this.logger.info(`[portal=${this.name}] Billing Cycle sort is confirmed descending after header update.`);
        return;
      }
    }

    throw this.portalError(
      'sort Billing Cycle descending',
      'Duke Billing Cycle descending order could not be confirmed. Refusing to use an unsafe early stop.',
    );
  }

  private async waitForBillingCycleDescendingSort(
    header: Locator,
    before: DukeTablePageSnapshot,
  ): Promise<DukeSortDirection> {
    const deadline = Date.now() + this.config.actionTimeoutMs;
    let latestDirection: DukeSortDirection = 'unknown';
    while (Date.now() < deadline) {
      const current = await this.tablePageSnapshot();
      latestDirection = await this.readBillingCycleSortDirection(header);
      if (latestDirection !== 'unknown' && current.fingerprint !== before.fingerprint) {
        await this.waitForBillingTableReady();
        return latestDirection;
      }
      await this.page.waitForTimeout(250);
    }
    return latestDirection;
  }

  private async readBillingCycleSortDirection(header: Locator): Promise<DukeSortDirection> {
    const signals = header.locator(dukeSelectors.tableSortSignal);
    const signalCount = await signals.count();
    const iconSignals: string[] = [];
    for (let index = 0; index < signalCount; index += 1) {
      const signal = signals.nth(index);
      const [ariaLabel, title, className, dataSort, dataSortDirection] = await Promise.all([
        signal.getAttribute('aria-label'),
        signal.getAttribute('title'),
        signal.getAttribute('class'),
        signal.getAttribute('data-sort'),
        signal.getAttribute('data-sort-direction'),
      ]);
      for (const value of [ariaLabel, title, className, dataSort, dataSortDirection]) {
        if (value) iconSignals.push(value);
      }
    }
    return detectDukeSortDirection({
      ariaSort: await header.getAttribute('aria-sort'),
      dataSort: await header.getAttribute('data-sort'),
      dataSortDirection: await header.getAttribute('data-sort-direction'),
      className: (await header.getAttribute('class')) ?? '',
      iconSignals,
    });
  }

  private async assertDisplayedBillingCyclesDescending(): Promise<void> {
    const rows = await this.readRealBillRows();
    if (rows.length === 0) return;
    if (!canUseDukeDescendingEarlyStop(
      this.billingCycleSortDirection,
      rows.map((row) => row.billingCycleStart),
    )) {
      throw this.portalError(
        'verify Billing Cycle descending order',
        'Displayed Billing Cycle start dates are not in non-increasing order. Refusing to use an unsafe early stop.',
      );
    }
  }

  private formatDateForLog(value: Date): string {
    return value.toISOString().slice(0, 10);
  }

  private async traverseTablePages(
    visit: (pageNumber: number) => Promise<boolean | void>,
    maximumPages = this.config.maximumTablePages,
  ): Promise<void> {
    await this.ensureRowsPerPageTwentyFive();
    await this.goToFirstTablePage();
    const seenFingerprints = new Set<string>();
    const seenPaginationRanges = new Set<string>();

    for (let scannedPages = 1; scannedPages <= maximumPages; scannedPages += 1) {
      const snapshot = await this.tablePageSnapshot();
      if (snapshot.emptyMessage !== null) {
        this.logger.info('[portal=duke] Billing table has a confirmed empty state; stopping pagination.');
        return;
      }
      if (snapshot.realRowCount === 0) {
        throw this.portalError(
          'paginate billing table',
          'The billing table has no real bill rows and no confirmed empty state.',
        );
      }
      if (seenFingerprints.has(snapshot.fingerprint)) {
        this.logger.warn(
          '[portal=duke] A previously visited bill-row fingerprint appeared again; stopping pagination safely.',
        );
        return;
      }
      if (snapshot.paginationRange.length === 0) {
        this.logger.warn(
          '[portal=duke] The visible pagination range is unavailable; stopping pagination safely.',
        );
        return;
      }
      if (seenPaginationRanges.has(snapshot.paginationRange)) {
        this.logger.warn(
          `[portal=duke] Pagination range "${snapshot.paginationRange}" appeared again; stopping pagination safely.`,
        );
        return;
      }
      seenFingerprints.add(snapshot.fingerprint);
      seenPaginationRanges.add(snapshot.paginationRange);

      this.currentTablePage = snapshot.currentPage ?? scannedPages;
      const next = await this.paginationControl('next');
      const nextButtonDisabled = !(await this.controlIsEnabled(next));
      this.logger.info(
        `[portal=${this.name}] Billing range="${snapshot.paginationRange}" currentPage=${snapshot.currentPage ?? 'unknown'} totalPages=${snapshot.totalPages ?? 'unknown'} firstBillingCycleStart=${snapshot.firstBillingCycleStart ?? 'none'} lastBillingCycleStart=${snapshot.lastBillingCycleStart ?? 'none'} sortDirection=${this.billingCycleSortDirection} startDateBoundaryReached=false realRowCount=${snapshot.realRowCount} nextButtonDisabled=${nextButtonDisabled}`,
      );

      if (await visit(this.currentTablePage)) return;
      if (nextButtonDisabled) return;
      if (
        snapshot.currentPage !== null &&
        snapshot.totalPages !== null &&
        snapshot.currentPage >= snapshot.totalPages
      ) {
        return;
      }
      if (scannedPages >= maximumPages) {
        if (maximumPages < this.config.maximumTablePages) return;
        break;
      }

      const advance = await this.clickPaginationControl(next, snapshot);
      this.logger.info(
        `[portal=${this.name}] Pagination advance from range="${snapshot.paginationRange}": rangeChanged=${advance.rangeChanged} fingerprintChanged=${advance.fingerprintChanged}`,
      );
      if (!advance.rangeChanged || !advance.fingerprintChanged) {
        this.logger.warn(
          '[portal=duke] Pagination did not change both the visible range and real-row fingerprint; stopping safely.',
        );
        return;
      }
    }

    throw this.portalError(
      'paginate billing table',
      `Exceeded the safety limit of ${maximumPages} pages.`,
    );
  }

  /**
   * A visible table with one row is frequently Duke's loading/skeleton row.
   * Do not allow scanning until the selected partner has real bill data, or
   * Duke has rendered an explicit empty result and the table has settled.
   */
  private async waitForBillingTableReady(
    expectedAccount?: PortalAccount,
    beforeSwitchFingerprint?: string,
    switchActivity?: PartnerSwitchActivity,
  ): Promise<BillingTableReadiness> {
    const deadline = Date.now() + this.config.navigationTimeoutMs;
    let previousFingerprint: string | undefined;
    let stableObservations = 0;
    let previousLoading: boolean | undefined;
    let sawLoading = false;

    while (Date.now() < deadline) {
      if (expectedAccount) {
        const selectorText = (await (await this.businessPartnerControl()).innerText().catch(() => ''))
          .replace(/\s+/gu, ' ');
        if (!selectorText.includes(expectedAccount.id)) {
          throw new Error(`Duke selector changed away from requested Business Partner ${expectedAccount.id}.`);
        }
      }

      const state = await this.billingTableReadiness();
      if (previousLoading !== state.loading) {
        this.logger.info(
          `[portal=${this.name}${expectedAccount ? ` account=${expectedAccount.id}` : ''}] Billing loading state: ${state.loading ? 'loading' : 'settled'}.`,
        );
        previousLoading = state.loading;
      }
      sawLoading ||= state.loading;
      stableObservations = state.fingerprint === previousFingerprint ? stableObservations + 1 : 0;
      previousFingerprint = state.fingerprint;

      const hasRealData = state.realRowCount > 0;
      const hasConfirmedEmptyState = state.emptyMessage !== null;
      const switchEvidenceSatisfied =
        beforeSwitchFingerprint === undefined ||
        state.fingerprint !== beforeSwitchFingerprint ||
        switchActivity?.sawRequestOrNavigation === true ||
        sawLoading;
      if (
        !state.loading &&
        (hasRealData || hasConfirmedEmptyState) &&
        stableObservations >= 1 &&
        switchEvidenceSatisfied
      ) {
        this.logger.info(
          `[portal=${this.name}${expectedAccount ? ` account=${expectedAccount.id}` : ''}] Billing table ready: realRows=${state.realRowCount}; page="${state.pageIndicator || 'unknown'}"; empty=${state.emptyMessage !== null}.`,
        );
        return state;
      }
      await this.page.waitForTimeout(250);
    }

    throw new Error(
      `Duke billing table did not reach a stable real-row or explicit-empty state within ${this.config.navigationTimeoutMs / 1_000} seconds.`,
    );
  }

  private async billingTableReadiness(): Promise<BillingTableReadiness> {
    const table = this.billingTable();
    const tableText = normalizeBillField((await table.innerText().catch(() => '')) ?? '');
    const loading =
      (await table.locator(dukeSelectors.tableLoadingIndicator).filter({ visible: true }).count()) > 0 ||
      (await table.getAttribute('aria-busy')) === 'true';
    const pageIndicator = await this.readPaginationRange();
    const realRows = await this.readRealBillRows();
    const emptyMessage = realRows.length === 0 ? dukeEmptyStateMessage(tableText) : null;
    const { currentPage } = parseDukePaginationMetadata(pageIndicator);
    const isFirstPage = currentPage === null || currentPage === 1;
    const first = realRows[0];
    const fingerprintSource = [
      first?.accountNumber ?? '',
      first?.billingCycle ?? '',
      String(realRows.length),
      pageIndicator,
      emptyMessage ?? '',
      String(loading),
    ].join('|');
    return {
      fingerprint: createHash('sha256').update(fingerprintSource).digest('hex'),
      realRowCount: realRows.length,
      firstAccountNumber: first?.accountNumber ?? null,
      firstBillingCycle: first?.billingCycle ?? null,
      emptyMessage,
      loading,
      pageIndicator,
      isFirstPage,
    };
  }

  private async assertBillingTableReadyOnFirstPage(
    expectedAccount?: PortalAccount,
  ): Promise<BillingTableReadiness> {
    const state = await this.waitForBillingTableReady(expectedAccount);
    if (!state.isFirstPage) {
      throw new Error(`Duke billing table did not reset to page 1; indicator was "${state.pageIndicator}".`);
    }
    return state;
  }

  private observePartnerSwitchActivity(): PartnerSwitchActivity {
    const activity: PartnerSwitchActivity = {
      sawRequestOrNavigation: false,
      stop: () => this.page.off('response', onResponse),
    };
    const onResponse = (response: { request(): { resourceType(): string } }): void => {
      const resourceType = response.request().resourceType();
      if (resourceType === 'xhr' || resourceType === 'fetch' || resourceType === 'document') {
        activity.sawRequestOrNavigation = true;
      }
    };
    this.page.on('response', onResponse);
    return activity;
  }

  private async readRealBillRows(): Promise<DukeRealBillRow[]> {
    let columns: DukeColumnMap;
    try {
      columns = await this.readColumnMap();
    } catch {
      return [];
    }
    const rows = this.tableRows();
    const result: DukeRealBillRow[] = [];
    const rowCount = await rows.count();
    for (let index = 0; index < rowCount; index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible())) continue;
      try {
        const cells = row.locator(dukeSelectors.tableCells);
        const accountNumber = normalizeBillField(await this.readCell(cells, columns.accountNumber));
        const billingCycle = normalizeBillField(await this.readCell(cells, columns.billingCycle));
        const serviceAddress = normalizeBillField(await this.readCell(cells, columns.serviceAddress));
        if (!isRealDukeBillRow(accountNumber, serviceAddress, billingCycle)) continue;
        const cycle = parseBillingCycle(billingCycle);
        result.push({
          accountNumber,
          billingCycle,
          billingCycleStart: cycle.start,
          uniqueKey: createBillUniqueKey(accountNumber, cycle.startIso, cycle.endIso),
        });
      } catch {
        // Skeleton, header, and incomplete rows are deliberately not real rows.
      }
    }
    return result;
  }

  private async tablePageSnapshot(): Promise<DukeTablePageSnapshot> {
    const table = this.billingTable();
    const rows = await this.readRealBillRows();
    const tableText = normalizeBillField((await table.innerText().catch(() => '')) ?? '');
    const emptyMessage = rows.length === 0 ? dukeEmptyStateMessage(tableText) : null;
    const paginationRange = await this.readPaginationRange();
    const { currentPage, totalPages } = parseDukePaginationMetadata(paginationRange);
    const rowKeys = rows.map((row) => row.uniqueKey);
    const first = rows[0];
    const last = rows.at(-1);

    return {
      fingerprint: createHash('sha256')
        .update(createDukeBillRowsFingerprint(rowKeys, emptyMessage))
        .digest('hex'),
      paginationRange,
      currentPage,
      totalPages,
      realRowCount: rows.length,
      firstRowUniqueKey: rowKeys[0] ?? null,
      lastRowUniqueKey: rowKeys.at(-1) ?? null,
      firstBillingCycleStart: first ? first.billingCycleStart.toISOString().slice(0, 10) : null,
      lastBillingCycleStart: last ? last.billingCycleStart.toISOString().slice(0, 10) : null,
      emptyMessage,
    };
  }

  private async readPaginationRange(): Promise<string> {
    const candidates = [
      // The live Business Portal renders the range as a plain footer span
      // (for example, "1-10 of 2000") with no pagination role, test id, or
      // aria label. Prefer its exact visible text before generic fallbacks.
      this.page
        .getByText(/\d+\s*-\s*\d+\s+of\s+\d+/iu, { exact: true })
        .filter({ visible: true }),
      this.page.locator(dukeSelectors.paginationRange).filter({ visible: true }),
      this.page.locator(dukeSelectors.pageIndicator).filter({ visible: true }),
      this.page.locator(dukeSelectors.paginationRegion).filter({ visible: true }),
    ];
    for (const candidate of candidates) {
      const texts = await candidate.allInnerTexts().catch(() => []);
      for (const text of texts) {
        const match = /\d+\s*-\s*\d+\s+of\s+\d+/iu.exec(text);
        if (match) return normalizeBillField(match[0]);
      }
    }
    return '';
  }

  private async goToFirstTablePage(): Promise<void> {
    await this.billingTable().waitFor({ state: 'visible' });
    const initialSnapshot = await this.tablePageSnapshot();
    if (initialSnapshot.currentPage === 1) return;

    const first = await this.paginationControl('first');
    if ((await first.count()) > 0 && (await this.controlIsEnabled(first))) {
      const advance = await this.clickPaginationControl(first, initialSnapshot);
      if (!advance.fingerprintChanged) {
        throw this.portalError(
          'return to first billing table page',
          'The billing rows did not change after the first-page action.',
        );
      }
      return;
    }

    const previous = await this.paginationControl('previous');
    for (let steps = 0; steps < this.config.maximumTablePages; steps += 1) {
      if (!(await this.controlIsEnabled(previous))) return;
      const before = await this.tablePageSnapshot();
      const advance = await this.clickPaginationControl(previous, before);
      if (!advance.fingerprintChanged) {
        throw this.portalError(
          'return to first billing table page',
          'The billing rows did not change after the previous-page action.',
        );
      }
      if ((await this.tablePageSnapshot()).currentPage === 1) return;
    }
    throw this.portalError(
      'return to first billing table page',
      `Exceeded the safety limit of ${this.config.maximumTablePages} previous-page clicks.`,
    );
  }

  private async clickPaginationControl(
    control: Locator,
    previous: DukeTablePageSnapshot,
  ): Promise<ReturnType<typeof hasDukePaginationAdvanced>> {
    await control.click();
    try {
      // Poll for the table to change instead of page.waitForFunction: esbuild's
      // keepNames transform wraps the serialized function with an undefined
      // __name() helper in the browser.
      const deadline = Date.now() + this.config.actionTimeoutMs;
      while (Date.now() < deadline) {
        const current = await this.tablePageSnapshot();
        const hasSettledRows = current.realRowCount > 0 || current.emptyMessage !== null;
        const advance = hasDukePaginationAdvanced(previous, current);
        if (hasSettledRows && advance.rangeChanged && advance.fingerprintChanged) {
          await this.billingTable().waitFor({ state: 'visible' });
          return advance;
        }
        await this.page.waitForTimeout(250);
      }
      return hasDukePaginationAdvanced(previous, await this.tablePageSnapshot());
    } catch (error) {
      throw this.portalError(
        'wait for billing table page update',
        'The table did not change after a pagination action.',
        {},
        error,
      );
    }
  }

  private async paginationControl(kind: PaginationControl): Promise<Locator> {
    const accessibleRegion = this.page.getByRole('navigation', {
      name: dukeAccessibleNames.paginationRegion,
    });
    const configuredRegion = this.page.locator(dukeSelectors.paginationRegion);
    if (kind === 'first') {
      return this.preferredExistingLocator([
        accessibleRegion.getByRole('button', { name: dukeAccessibleNames.firstPage }),
        accessibleRegion.getByRole('link', { name: dukeAccessibleNames.firstPage }),
        configuredRegion.getByRole('button', { name: dukeAccessibleNames.firstPage }),
        configuredRegion.getByRole('link', { name: dukeAccessibleNames.firstPage }),
        this.page.locator(dukeSelectors.firstPageButton),
      ]);
    }
    if (kind === 'previous') {
      return this.preferredExistingLocator([
        accessibleRegion.getByRole('button', { name: dukeAccessibleNames.previousPage }),
        accessibleRegion.getByRole('link', { name: dukeAccessibleNames.previousPage }),
        configuredRegion.getByRole('button', { name: dukeAccessibleNames.previousPage }),
        configuredRegion.getByRole('link', { name: dukeAccessibleNames.previousPage }),
        this.page.locator(dukeSelectors.previousPageButton),
      ]);
    }
    return this.preferredExistingLocator([
      accessibleRegion.getByRole('button', { name: dukeAccessibleNames.nextPage }),
      accessibleRegion.getByRole('link', { name: dukeAccessibleNames.nextPage }),
      configuredRegion.getByRole('button', { name: dukeAccessibleNames.nextPage }),
      configuredRegion.getByRole('link', { name: dukeAccessibleNames.nextPage }),
      this.page.locator(dukeSelectors.nextPageButton),
    ]);
  }

  private async ensureRowsPerPageTwentyFive(): Promise<void> {
    const control = this.page.locator(dukeSelectors.rowsPerPageControl).filter({ visible: true }).first();
    if ((await control.count()) === 0) {
      this.logger.warn(
        `[portal=${this.name}] Rows-per-page control was not found; continuing with Duke's current page size.`,
      );
      return;
    }

    const currentValue = normalizeBillField(await control.innerText().catch(() => ''));
    if (currentValue === '25') return;

    await control.click();
    const option = await this.waitForPreferredVisibleLocator(
      [
        this.page.getByRole('option', { name: '25', exact: true }),
        this.page.getByRole('menuitem', { name: '25', exact: true }),
        this.page.getByRole('button', { name: '25', exact: true }),
        this.page.getByText('25', { exact: true }),
      ],
      'Duke rows-per-page option 25',
    );
    await option.click();
    await this.waitForBillingTableReady();
    const range = await this.readPaginationRange();
    const metadata = parseDukePaginationMetadata(range);
    const pageSize =
      metadata.rangeStart === null || metadata.rangeEnd === null
        ? null
        : metadata.rangeEnd - metadata.rangeStart + 1;
    this.logger.info(
      `[portal=${this.name}] Rows per page set to 25; visibleRange="${range || 'unknown'}" actualPageSize=${pageSize ?? 'unknown'}.`,
    );
  }

  private async controlIsEnabled(control: Locator): Promise<boolean> {
    const exists = (await control.count()) > 0;
    if (!exists) {
      return false;
    }
    const visible = await control.isVisible();
    const disabledAncestor = control
      .locator('xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " disabled ")]')
      .first();
    const [enabled, disabledAttribute, ariaDisabled, className, disabledAncestorExists] = await Promise.all([
      control.isEnabled(),
      control.getAttribute('disabled'),
      control.getAttribute('aria-disabled'),
      control.getAttribute('class').then((value) => value ?? ''),
      disabledAncestor.count(),
    ]);
    const ancestorClassName =
      disabledAncestorExists > 0
        ? ((await disabledAncestor.getAttribute('class')) ?? '').toLowerCase()
        : '';
    return isDukePaginationControlEnabled({
      exists,
      visible,
      enabled,
      disabledAttribute,
      ariaDisabled,
      className,
      ancestorClassName,
    });
  }

  private billingTable(): Locator {
    return this.page.locator(dukeSelectors.billingTable).filter({ visible: true }).first();
  }

  private tableRows(): Locator {
    return this.billingTable().locator(dukeSelectors.tableRows);
  }

  private async readColumnMap(): Promise<DukeColumnMap> {
    const headers = await this.billingTable()
      .locator(dukeSelectors.tableHeaders)
      .allInnerTexts();
    try {
      return mapDukeColumns(headers);
    } catch (error) {
      throw this.portalError('map billing table columns', errorMessage(error), {}, error);
    }
  }

  private async parseBillRow(row: Locator, columns: DukeColumnMap): Promise<ParsedBillRow> {
    const cells = row.locator(dukeSelectors.tableCells);
    const accountNumber = normalizeBillField(await this.readCell(cells, columns.accountNumber));
    const serviceAddress = normalizeBillField(await this.readCell(cells, columns.serviceAddress));
    const billingCycleText = normalizeBillField(await this.readCell(cells, columns.billingCycle));

    if (!accountNumber) {
      throw this.portalError('read billing table row', 'Account number is empty.');
    }
    if (!serviceAddress) {
      throw this.portalError('read billing table row', 'Service address is empty.', {
        account: accountNumber,
      });
    }

    let cycle: ReturnType<typeof parseBillingCycle>;
    try {
      cycle = parseBillingCycle(billingCycleText);
    } catch (error) {
      throw this.portalError('parse billing cycle', errorMessage(error), {
        account: accountNumber,
        billingCycle: billingCycleText,
      });
    }

    const dueDate =
      columns.dueDate === undefined
        ? ''
        : normalizeBillField(await this.readCell(cells, columns.dueDate));
    const amountDue =
      columns.amountDue === undefined
        ? ''
        : normalizeBillField(await this.readCell(cells, columns.amountDue));
    const checkbox = await this.findRowCheckbox(row, columns.selection);
    const pdfLinkCandidate = row.locator(dukeSelectors.billPdfLink).filter({ visible: true }).first();
    const pdfLink = (await pdfLinkCandidate.count()) > 0 ? pdfLinkCandidate : null;
    const uniqueKey = createBillUniqueKey(accountNumber, cycle.startIso, cycle.endIso);

    return {
      bill: {
        portal: this.name,
        accountNumber,
        serviceAddress,
        billingCycleStart: cycle.startIso,
        billingCycleEnd: cycle.endIso,
        ...(dueDate ? { dueDate } : {}),
        ...(amountDue ? { amountDue } : {}),
        uniqueKey,
      },
      checkbox,
      pdfLink,
    };
  }

  private async findBillOnCurrentPage(bill: Bill, operation: string): Promise<ParsedBillRow | null> {
    const columns = await this.readColumnMap();
    const rows = this.tableRows();
    const rowCount = await rows.count();
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row = rows.nth(rowIndex);
      if (!(await row.isVisible())) continue;
      const parsed = await this.tryParseBillRow(row, columns, operation);
      if (parsed?.bill.uniqueKey === bill.uniqueKey) return parsed;
    }
    return null;
  }

  private async tryParseBillRow(
    row: Locator,
    columns: DukeColumnMap,
    operation: string,
  ): Promise<ParsedBillRow | null> {
    try {
      return await this.parseBillRow(row, columns);
    } catch (error) {
      this.logger.warn(
        `[portal=${this.name} page=${this.currentTablePage ?? 'unknown'}] Skipping unreadable bill row during ${operation}: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private async findRowCheckbox(row: Locator, selectionColumn?: number): Promise<Locator> {
    const cells = row.locator(dukeSelectors.tableCells);
    const scoped =
      selectionColumn === undefined
        ? row.getByRole(dukeAccessibleNames.rowSelectionCheckbox)
        : cells
            .nth(selectionColumn)
            .getByRole(dukeAccessibleNames.rowSelectionCheckbox);
    const checkbox = scoped.or(row.locator(dukeSelectors.rowSelectionCheckbox)).first();
    if ((await checkbox.count()) === 0) {
      throw this.portalError(
        'read billing table row',
        'Required selection checkbox was not found. Verify the Duke checkbox selector.',
      );
    }
    return checkbox;
  }

  private async readCell(cells: Locator, index: number): Promise<string> {
    if (index >= (await cells.count())) {
      throw this.portalError(
        'read billing table row',
        `Column index ${index} is outside the row's available cells.`,
      );
    }
    return cells.nth(index).innerText();
  }

  private async readSelectedCount(): Promise<number | null> {
    const configuredCounter = this.page
      .locator(dukeSelectors.selectedCount)
      .filter({ visible: true })
      .first();
    const counter =
      (await configuredCounter.count()) > 0
        ? configuredCounter
        : this.page
            .getByText(/\d[\d,]*\s+accounts?\s+have\s+been\s+selected/i)
            .filter({ visible: true })
            .first();
    if ((await counter.count()) === 0) return null;
    const attribute = await counter.getAttribute('data-selected-count');
    const text = attribute ?? (await counter.innerText());
    const match = /\d[\d,]*/u.exec(text);
    return match ? Number(match[0].replaceAll(',', '')) : null;
  }

  private async countCheckedRowsAcrossPages(): Promise<number> {
    let checkedRows = 0;
    await this.traverseTablePages(async () => {
      const rows = this.tableRows();
      const rowCount = await rows.count();
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row = rows.nth(rowIndex);
        if (!(await row.isVisible())) continue;
        const checkbox = await this.findRowCheckbox(row);
        if (await checkbox.isChecked()) checkedRows += 1;
      }
    });
    return checkedRows;
  }

  private async clearCheckedRowsAcrossPages(): Promise<void> {
    // In targeted mode we know exactly which bill was selected. Search only
    // until those keys have been unchecked; scanning the entire history can
    // otherwise leave the browser hundreds of pages away from the target.
    const targetKeys = this.selectedBatchKeys.size > 0 ? new Set(this.selectedBatchKeys) : null;
    await this.traverseTablePages(async () => {
      // Checking or unchecking a Duke row can replace the table DOM. Reacquire
      // rows after every change so the next checkbox is always live.
      let changed = true;
      while (changed) {
        changed = false;
        const rows = this.tableRows();
        const rowCount = await rows.count();
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
          const row = rows.nth(rowIndex);
          if (!(await row.isVisible())) continue;
          const checkbox = await this.findRowCheckbox(row);
          if (!(await checkbox.isChecked())) continue;
          let selectedKey: string | undefined;
          if (targetKeys) {
            const columns = await this.readColumnMap();
            const parsed = await this.tryParseBillRow(row, columns, 'clear selections');
            if (!parsed || !targetKeys.has(parsed.bill.uniqueKey)) continue;
            selectedKey = parsed.bill.uniqueKey;
          }
          await checkbox.uncheck();
          if (targetKeys && selectedKey) targetKeys.delete(selectedKey);
          changed = true;
          break;
        }
      }
      return targetKeys?.size === 0;
    });
  }

  private async classifyLoginFailure(): Promise<string> {
    const alert = this.page
      .locator(dukeSelectors.loginError)
      .filter({ visible: true })
      .first();
    const text = normalizeBillField(await alert.innerText().catch(() => ''));
    if (/locked|too many attempts|disabled/i.test(text)) {
      return 'Duke authentication failed because the account appears to be locked or disabled.';
    }
    if (/invalid|incorrect|not match|unable to sign/i.test(text)) {
      return 'Duke authentication rejected the username or password.';
    }
    return 'Duke authentication failed. Check the credentials and the live login selectors.';
  }

  private async restoreBillingTableAfterDownload(): Promise<void> {
    const table = this.billingTable();
    if ((await table.count()) > 0 && (await table.isVisible())) return;
    await this.navigateToBills();
  }

  private async waitForPreferredVisibleLocator(
    candidates: readonly Locator[],
    label: string,
  ): Promise<Locator> {
    const visibleCandidates = candidates.map((candidate) =>
      candidate.filter({ visible: true }).first(),
    );
    try {
      await Promise.any(
        visibleCandidates.map((candidate) =>
          candidate.waitFor({ state: 'visible', timeout: this.config.actionTimeoutMs }),
        ),
      );
    } catch {
      throw new Error(`${label} was not found or did not become visible.`);
    }

    for (const candidate of visibleCandidates) {
      if ((await candidate.count()) > 0 && (await candidate.isVisible())) return candidate;
    }
    throw new Error(`${label} disappeared before it could be used.`);
  }

  private async preferredExistingLocator(candidates: readonly Locator[]): Promise<Locator> {
    for (const candidate of candidates) {
      const visible = candidate.filter({ visible: true }).first();
      if ((await visible.count()) > 0) return visible;
    }
    for (const candidate of candidates) {
      const first = candidate.first();
      if ((await first.count()) > 0) return first;
    }
    const firstCandidate = candidates[0];
    if (!firstCandidate) throw new Error('Internal error: no locator candidates were provided.');
    return firstCandidate.first();
  }

  private portalError(
    operation: string,
    message: string,
    extra: Readonly<Record<string, string | number | undefined>> = {},
    cause?: unknown,
  ): Error {
    return contextualError(
      operation,
      message,
      {
        portal: this.name,
        page: this.currentTablePage,
        ...extra,
      },
      cause,
    );
  }
}
