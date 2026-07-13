import { createHash } from 'node:crypto';

import type { BrowserContext, Locator, Page } from 'playwright';

import type { Bill } from '../../types/Bill.js';
import { createBillUniqueKey, normalizeBillField } from '../../types/Bill.js';
import type { BillingPortal } from '../../types/BillingPortal.js';
import { dateRangesOverlap, parseBillingCycle, parseIsoDate } from '../../utils/dates.js';
import type { Logger } from '../../utils/logging.js';
import { contextualError, errorMessage } from '../../utils/logging.js';
import type { DukeConfig, DukeCredentials } from './config.js';
import { downloadDukePdf } from './downloadPdf.js';
import { dukeAccessibleNames, dukeSelectors } from './selectors.js';
import type { DukeColumnMap } from './tableColumns.js';
import { mapDukeColumns } from './tableColumns.js';

interface ParsedBillRow {
  bill: Bill;
  checkbox: Locator;
}

type PaginationControl = 'first' | 'previous' | 'next';

export class DukePortal implements BillingPortal {
  public readonly name = 'duke';

  private currentTablePage: number | undefined;

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
      await this.page.goto(this.config.loginUrl, { waitUntil: 'domcontentloaded' });

      const username = await this.waitForPreferredVisibleLocator(
        [
          this.page.getByLabel(dukeAccessibleNames.usernameField),
          this.page.getByPlaceholder(dukeAccessibleNames.usernameField),
          this.page.locator(dukeSelectors.usernameInput),
        ],
        'Duke username field',
      );
      const password = await this.waitForPreferredVisibleLocator(
        [
          this.page.getByLabel(dukeAccessibleNames.passwordField),
          this.page.getByPlaceholder(dukeAccessibleNames.passwordField),
          this.page.locator(dukeSelectors.passwordInput),
        ],
        'Duke password field',
      );

      await username.fill(this.credentials.username);
      await password.fill(this.credentials.password);

      const submit = await this.waitForPreferredVisibleLocator(
        [
          this.page.getByRole('button', { name: dukeAccessibleNames.loginSubmit }),
          this.page.locator(dukeSelectors.loginSubmit),
        ],
        'Duke login submit action',
      );
      await submit.click();

      let outcomeValue: unknown;
      try {
        const outcome = await this.page.waitForFunction(
          ({ errorSelector, successSelector, challengeSelector }) => {
            const visible = (element: Element | null): boolean => {
              if (!element) return false;
              const style = window.getComputedStyle(element);
              return (
                style.visibility !== 'hidden' &&
                style.display !== 'none' &&
                element.getClientRects().length > 0
              );
            };
            const firstVisible = (selector: string): Element | null =>
              [...document.querySelectorAll(selector)].find(visible) ?? null;
            const error = firstVisible(errorSelector);
            if (error && (error.textContent ?? '').trim().length > 0) return 'error';
            if (firstVisible(challengeSelector)) return 'challenge';
            if (firstVisible(successSelector)) return 'success';
            return null;
          },
          {
            errorSelector: dukeSelectors.loginError,
            successSelector: dukeSelectors.loginSuccess,
            challengeSelector: dukeSelectors.loginChallenge,
          },
          { timeout: this.config.navigationTimeoutMs },
        );
        outcomeValue = await outcome.jsonValue();
      } catch {
        throw new Error(
          'Duke login completion could not be verified. Check the live login-success selector and whether Duke requires MFA, terms acceptance, or a password reset.',
        );
      }

      if (outcomeValue === 'error') {
        throw new Error(await this.classifyLoginFailure());
      }
      if (outcomeValue === 'challenge') {
        throw new Error(
          'Duke login requires an interactive verification, MFA, terms, or password-reset step that this adapter does not automate.',
        );
      }
    } catch (error) {
      throw this.portalError('login', errorMessage(error), {}, error);
    }
  }

  public async navigateToBills(): Promise<void> {
    try {
      await this.page.goto(this.config.billsUrl, { waitUntil: 'domcontentloaded' });
      const outcome = await this.page.waitForFunction(
        ({ tableSelector, passwordSelector, errorSelector }) => {
          const visible = (element: Element | null): boolean => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            return (
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              element.getClientRects().length > 0
            );
          };
          const firstVisible = (selector: string): Element | null =>
            [...document.querySelectorAll(selector)].find(visible) ?? null;
          if (firstVisible(tableSelector)) return 'table';
          if (
            firstVisible(passwordSelector) ||
            firstVisible(errorSelector)
          ) {
            return 'login';
          }
          return null;
        },
        {
          tableSelector: dukeSelectors.billingTable,
          passwordSelector: dukeSelectors.passwordInput,
          errorSelector: dukeSelectors.loginError,
        },
        { timeout: this.config.navigationTimeoutMs },
      );
      if ((await outcome.jsonValue()) === 'login') {
        throw new Error('Duke redirected back to login; the authenticated session was not established.');
      }
      await this.billingTable().waitFor({
        state: 'visible',
        timeout: this.config.navigationTimeoutMs,
      });
      await this.goToFirstTablePage();
    } catch (error) {
      throw this.portalError('navigate to billing table', errorMessage(error), {}, error);
    }
  }

  public async scanBills(requestedStart: Date, requestedEnd: Date): Promise<Bill[]> {
    const matches: Bill[] = [];
    const seenKeys = new Set<string>();

    await this.traverseTablePages(async (pageNumber) => {
      this.logger.info(`Scanning page ${pageNumber}`);
      const columns = await this.readColumnMap();
      const rows = this.tableRows();
      const rowCount = await rows.count();

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row = rows.nth(rowIndex);
        if (!(await row.isVisible())) continue;
        const parsed = await this.parseBillRow(row, columns);
        if (seenKeys.has(parsed.bill.uniqueKey)) continue;
        seenKeys.add(parsed.bill.uniqueKey);

        const cycleStart = parseIsoDate(parsed.bill.billingCycleStart, 'billing cycle start');
        const cycleEnd = parseIsoDate(parsed.bill.billingCycleEnd, 'billing cycle end');
        if (dateRangesOverlap(cycleStart, cycleEnd, requestedStart, requestedEnd)) {
          matches.push(parsed.bill);
        }
      }
    });

    return matches;
  }

  public async selectBatch(bills: Bill[]): Promise<void> {
    if (bills.length === 0 || bills.length > 25) {
      throw this.portalError(
        'select batch',
        `Expected 1 to 25 bills but received ${bills.length}.`,
      );
    }

    const targets = new Map(bills.map((bill) => [bill.uniqueKey, bill]));
    if (targets.size !== bills.length) {
      throw this.portalError('select batch', 'The requested batch contains duplicate bill keys.');
    }

    const occurrences = new Map<string, number>();
    const selected = new Set<string>();

    await this.traverseTablePages(async () => {
      const columns = await this.readColumnMap();
      const rows = this.tableRows();
      const rowCount = await rows.count();

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row = rows.nth(rowIndex);
        if (!(await row.isVisible())) continue;
        const parsed = await this.parseBillRow(row, columns);
        const target = targets.get(parsed.bill.uniqueKey);

        if (!target) {
          if (await parsed.checkbox.isChecked()) {
            throw this.portalError(
              'select batch',
              'A non-target bill is selected; stale selections were not cleared.',
              {
                account: parsed.bill.accountNumber,
                billingCycle: `${parsed.bill.billingCycleStart}-to-${parsed.bill.billingCycleEnd}`,
              },
            );
          }
          continue;
        }

        const count = (occurrences.get(parsed.bill.uniqueKey) ?? 0) + 1;
        occurrences.set(parsed.bill.uniqueKey, count);
        if (count > 1) {
          throw this.portalError(
            'select batch',
            'Expected bill key was found more than once in the billing table.',
            {
              account: target.accountNumber,
              billingCycle: `${target.billingCycleStart}-to-${target.billingCycleEnd}`,
            },
          );
        }

        if (!(await parsed.checkbox.isChecked())) {
          await parsed.checkbox.check();
        }
        if (!(await parsed.checkbox.isChecked())) {
          throw this.portalError('select batch', 'The target checkbox did not remain selected.', {
            account: target.accountNumber,
            billingCycle: `${target.billingCycleStart}-to-${target.billingCycleEnd}`,
          });
        }
        selected.add(parsed.bill.uniqueKey);
      }
    });

    for (const bill of bills) {
      const occurrenceCount = occurrences.get(bill.uniqueKey) ?? 0;
      if (occurrenceCount !== 1) {
        throw this.portalError(
          'select batch',
          `Expected bill was found ${occurrenceCount} times; exactly one row is required.`,
          {
            account: bill.accountNumber,
            billingCycle: `${bill.billingCycleStart}-to-${bill.billingCycleEnd}`,
          },
        );
      }
    }

    if (selected.size !== bills.length) {
      throw this.portalError(
        'select batch',
        `Selected ${selected.size} of ${bills.length} expected bills.`,
      );
    }
  }

  public async downloadSelectedBatch(batchNumber: number, outputPath: string): Promise<string> {
    try {
      const printAction = await this.waitForPreferredVisibleLocator(
        [
          this.page.getByRole('button', { name: dukeAccessibleNames.printBills }),
          this.page.getByRole('link', { name: dukeAccessibleNames.printBills }),
          this.page.locator(dukeSelectors.printBillsButton),
        ],
        'Duke Print Bills action',
      );
      if (!(await this.controlIsEnabled(printAction))) {
        throw new Error('Duke Print Bills action is disabled.');
      }

      const downloadedPath = await downloadDukePdf({
        page: this.page,
        context: this.context,
        printAction,
        outputPath,
        timeoutMs: this.config.downloadTimeoutMs,
        responseUrlHints: dukeSelectors.pdfResponseUrlHints,
      });
      await this.restoreBillingTableAfterDownload();
      return downloadedPath;
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

  public async clearSelections(): Promise<void> {
    const currentCount = await this.readSelectedCount();
    if (currentCount === 0) return;

    const clearControl = await this.preferredExistingLocator([
      this.page.getByRole('button', { name: dukeAccessibleNames.clearSelections }),
      this.page.getByRole('link', { name: dukeAccessibleNames.clearSelections }),
      this.page.locator(dukeSelectors.clearSelectionsButton),
    ]);

    if ((await clearControl.count()) > 0 && (await this.controlIsEnabled(clearControl))) {
      try {
        await clearControl.click();
        const confirm = await this.preferredExistingLocator([
          this.page
            .getByRole('dialog')
            .getByRole('button', { name: dukeAccessibleNames.confirmClearSelections }),
          this.page.locator(dukeSelectors.confirmClearSelectionsButton),
        ]);
        if ((await confirm.count()) > 0 && (await confirm.isVisible())) {
          await confirm.click();
        }
        await this.verifySelectionCount(0);
        return;
      } catch (error) {
        this.logger.warn(
          `Duke global clear-selection action failed; checking every table page instead (${errorMessage(error)}).`,
        );
      }
    }

    await this.traverseTablePages(async () => {
      const rows = this.tableRows();
      const rowCount = await rows.count();
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row = rows.nth(rowIndex);
        if (!(await row.isVisible())) continue;
        const checkbox = await this.findRowCheckbox(row);
        if (await checkbox.isChecked()) {
          await checkbox.uncheck();
        }
      }
    });
    await this.verifySelectionCount(0);
  }

  public async verifySelectionCount(expectedCount: number): Promise<void> {
    const immediateCount = await this.readSelectedCount();
    if (expectedCount === 0 && immediateCount === null) {
      const checkedRows = await this.countCheckedRowsAcrossPages();
      if (checkedRows !== 0) {
        throw this.portalError(
          'verify selection count',
          `The selected-account counter is unavailable and ${checkedRows} checked row(s) remain; expected 0.`,
        );
      }
      return;
    }

    try {
      await this.page.waitForFunction(
        ({ selector, expected }) => {
          const element = [...document.querySelectorAll(selector)].find((candidate) => {
            const style = window.getComputedStyle(candidate);
            return (
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              candidate.getClientRects().length > 0
            );
          });
          if (!element) return expected === 0;
          const attribute = element.getAttribute('data-selected-count');
          const text = attribute ?? element.textContent ?? '';
          const match = /\d[\d,]*/u.exec(text);
          if (!match) return false;
          return Number(match[0].replaceAll(',', '')) === expected;
        },
        { selector: dukeSelectors.selectedCount, expected: expectedCount },
        { timeout: this.config.actionTimeoutMs },
      );
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

  private async traverseTablePages(
    visit: (pageNumber: number) => Promise<void>,
  ): Promise<void> {
    await this.goToFirstTablePage();
    const seenFingerprints = new Set<string>();

    for (let pageNumber = 1; pageNumber <= this.config.maximumTablePages; pageNumber += 1) {
      this.currentTablePage = pageNumber;
      const fingerprint = await this.tableFingerprint();
      if (seenFingerprints.has(fingerprint)) {
        throw this.portalError(
          'paginate billing table',
          'A previously visited table page appeared again; stopped to prevent an infinite loop.',
        );
      }
      seenFingerprints.add(fingerprint);

      await visit(pageNumber);

      const next = await this.paginationControl('next');
      if (!(await this.controlIsEnabled(next))) {
        return;
      }
      await this.clickPaginationControl(next);
    }

    throw this.portalError(
      'paginate billing table',
      `Exceeded the safety limit of ${this.config.maximumTablePages} pages.`,
    );
  }

  private async goToFirstTablePage(): Promise<void> {
    await this.billingTable().waitFor({ state: 'visible' });
    const first = await this.paginationControl('first');
    if ((await first.count()) > 0 && (await this.controlIsEnabled(first))) {
      await this.clickPaginationControl(first);
      return;
    }

    const previous = await this.paginationControl('previous');
    for (let steps = 0; steps < this.config.maximumTablePages; steps += 1) {
      if (!(await this.controlIsEnabled(previous))) return;
      await this.clickPaginationControl(previous);
    }
    throw this.portalError(
      'return to first billing table page',
      `Exceeded the safety limit of ${this.config.maximumTablePages} previous-page clicks.`,
    );
  }

  private async clickPaginationControl(control: Locator): Promise<void> {
    const previousState = await this.tableState();
    await control.click();
    try {
      await this.page.waitForFunction(
        ({
          tableSelector,
          rowSelector,
          loadingSelector,
          cellSelector,
          pageSelector,
          previousTableText,
          previousIndicatorText,
        }) => {
          const visible = (element: Element): boolean => {
            const style = window.getComputedStyle(element);
            return (
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              element.getClientRects().length > 0
            );
          };
          const table = [...document.querySelectorAll(tableSelector)].find(visible);
          if (!table) return false;
          const tableText = table.textContent ?? '';
          const indicatorText =
            [...document.querySelectorAll(pageSelector)].find(visible)?.textContent ?? '';
          if (
            tableText === previousTableText &&
            indicatorText === previousIndicatorText
          ) {
            return false;
          }
          if (table.matches(loadingSelector)) return false;
          const visibleLoading = [...table.querySelectorAll(loadingSelector)].some((element) => {
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden';
          });
          if (visibleLoading) return false;
          return [...table.querySelectorAll(rowSelector)].some(
            (row) =>
              row.querySelectorAll(cellSelector).length > 0 &&
              (row.textContent ?? '').trim().length > 0,
          );
        },
        {
          tableSelector: dukeSelectors.billingTable,
          rowSelector: dukeSelectors.tableRows,
          loadingSelector: dukeSelectors.tableLoadingIndicator,
          cellSelector: dukeSelectors.tableCells,
          pageSelector: dukeSelectors.pageIndicator,
          previousTableText: previousState.tableText,
          previousIndicatorText: previousState.indicatorText,
        },
        { timeout: this.config.actionTimeoutMs },
      );
      await this.billingTable().waitFor({ state: 'visible' });
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

  private async controlIsEnabled(control: Locator): Promise<boolean> {
    if ((await control.count()) === 0 || !(await control.isVisible())) return false;
    if (!(await control.isEnabled())) return false;
    const disabled = await control.getAttribute('disabled');
    const ariaDisabled = await control.getAttribute('aria-disabled');
    return disabled === null && ariaDisabled !== 'true';
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
    };
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
    const counter = this.page
      .locator(dukeSelectors.selectedCount)
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

  private async tableIdentity(): Promise<string> {
    const state = await this.tableState();
    return `${state.indicatorText}\n${state.tableText}`;
  }

  private async tableState(): Promise<{ tableText: string; indicatorText: string }> {
    const tableText = (await this.billingTable().textContent()) ?? '';
    const indicator = this.page
      .locator(dukeSelectors.pageIndicator)
      .filter({ visible: true })
      .first();
    const indicatorText =
      (await indicator.count()) > 0
        ? ((await indicator.textContent()) ?? '')
        : '';
    return { tableText, indicatorText };
  }

  private async tableFingerprint(): Promise<string> {
    return createHash('sha256').update(await this.tableIdentity()).digest('hex');
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
