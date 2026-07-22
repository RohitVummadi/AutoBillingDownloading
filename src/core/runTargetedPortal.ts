import { rename, rm } from 'node:fs/promises';

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

import type { AccountMap } from './accountMap.js';
import { createTargetOutputs } from './targetedOutput.js';
import { assertValidPdf, validatePdf } from '../pdf/validatePdf.js';
import { normalizeAccountNumber, type Bill } from '../types/Bill.js';
import type { BillingPortal } from '../types/BillingPortal.js';
import type { PortalAccount } from '../types/PortalAccount.js';
import { ensureDirectory, writeJsonAtomically } from '../utils/files.js';
import type { Logger } from '../utils/logging.js';
import { contextualError, errorMessage } from '../utils/logging.js';
import { retry } from '../utils/retry.js';

export interface TargetStartMonthBillingPortal extends BillingPortal {
  scanBillsForTargetStartMonth(
    targetAccountNumbers: ReadonlySet<string>,
    billingStartMonth: Date,
    onMatch?: (bill: Bill) => Promise<void>,
  ): Promise<Bill[]>;
  /** Optional fast path for adapters that can download the row just found on the current page. */
  downloadTargetBill?(
    bill: Bill,
    batchNumber: number,
    outputPath: string,
  ): Promise<string>;
}

export interface TargetedRunOptions {
  portalName: string;
  accountMap: AccountMap;
  billingStartMonth: Date;
  outputDirectory: string;
  headless: boolean;
  currentAccountOnly: boolean;
  logger: Logger;
  createPortal(context: { page: Page; context: BrowserContext }): TargetStartMonthBillingPortal;
}

export interface TargetedRunResult {
  reportPath: string;
  downloaded: number;
  reused: number;
  unmatched: number;
  hadFailures: boolean;
}

type TargetStatus = 'pending' | 'downloaded' | 'reused' | 'unmatched' | 'failed';

interface TargetedReportEntry {
  accountNumber: string;
  buildingName: string;
  status: TargetStatus;
  outputFile: string;
  bill: Bill | null;
  sourcePartnerIds: string[];
  message: string | null;
}

interface TargetedRunReport {
  portal: string;
  mode: 'target-start-month';
  sourceCsv: string;
  billingStartMonth: string;
  startedAt: string;
  completedAt: string | null;
  targets: TargetedReportEntry[];
}

export async function runTargetedPortal(options: TargetedRunOptions): Promise<TargetedRunResult> {
  const outputDirectory = options.outputDirectory;
  const reportPath = `${outputDirectory}/targeted-run.json`;
  await ensureDirectory(outputDirectory);
  const outputs = createTargetOutputs(outputDirectory, options.accountMap.entries);
  const prior = await readPriorReport(reportPath);
  const priorByAccount = new Map(prior?.targets.map((target) => [target.accountNumber, target]) ?? []);
  const report: TargetedRunReport = {
    portal: options.portalName,
    mode: 'target-start-month',
    sourceCsv: options.accountMap.sourcePath,
    billingStartMonth: formatMonth(options.billingStartMonth),
    startedAt: new Date().toISOString(),
    completedAt: null,
    targets: outputs.map((output) => ({
      accountNumber: output.accountNumber,
      buildingName: output.buildingName,
      status: 'pending',
      outputFile: output.fileName,
      bill: null,
      sourcePartnerIds: [],
      message: null,
    })),
  };
  const reportByAccount = new Map(report.targets.map((target) => [target.accountNumber, target]));
  const outputByAccount = new Map(
    outputs.map((output) => [normalizeAccountNumber(output.accountNumber), output]),
  );
  await writeJsonAtomically(reportPath, report);

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let failed = false;
  try {
    options.logger.info(
      `Starting targeted ${formatMonth(options.billingStartMonth)} billing-start-month portal run: ${options.portalName}`,
    );
    browser = await chromium.launch({ headless: options.headless });
    context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const portal = options.createPortal({ page, context });
    if (portal.name !== options.portalName) {
      throw new Error(`Portal factory returned "${portal.name}" while "${options.portalName}" was requested.`);
    }
    await portal.login();
    await portal.navigateToBills();

    const discoveredAccounts = await portal.listAccounts();
    const initialCurrent = discoveredAccounts.find((account) => account.isCurrent);
    const partners = choosePartners(discoveredAccounts, initialCurrent, options.currentAccountOnly);
    if (partners.length === 0) throw new Error('No current Business Partner account was identified.');

    const unresolved = new Set(outputs.map((output) => output.accountNumber));
    const partnerFailures: string[] = [];
    let activePartnerId = initialCurrent?.id;
    let sequence = 0;
    for (const partner of partners) {
      if (unresolved.size === 0) break;
      try {
        options.logger.info(
          `[portal=${options.portalName} partner=${partner.id}] Starting targeted scan; remainingTargets=${unresolved.size}.`,
        );
        if (activePartnerId !== partner.id) {
          await portal.activateAccount(partner);
          activePartnerId = partner.id;
        }
        const processMatch = async (bill: Bill): Promise<void> => {
          const output = outputByAccount.get(normalizeAccountNumber(bill.accountNumber));
          if (!output || !unresolved.has(output.accountNumber)) return;
          unresolved.delete(output.accountNumber);

          const entry = reportByAccount.get(output.accountNumber)!;
          entry.bill = bill;
          entry.sourcePartnerIds = [partner.id];
          options.logger.info(
            `[portal=${options.portalName} partner=${partner.id} account=${output.accountNumber}] Target match accepted: billingCycle=${bill.billingCycleStart}-to-${bill.billingCycleEnd}; starting download.`,
          );
          const previous = priorByAccount.get(output.accountNumber);
          if (canReuse(previous, bill, output.fileName) && (await validatePdf(output.filePath)).valid) {
            entry.status = 'reused';
            entry.message = null;
            await writeJsonAtomically(reportPath, report);
            options.logger.info(
              `[portal=${options.portalName} partner=${partner.id} account=${output.accountNumber}] Existing valid PDF reused; remainingTargets=${unresolved.size}.`,
            );
            return;
          }

          sequence += 1;
          const stagingPath = `${output.filePath}.${process.pid}.${Date.now()}.download.pdf`;
          let selectionAttempted = false;
          try {
            await retry(
              async () => {
                if (portal.downloadTargetBill) {
                  await portal.downloadTargetBill(bill, sequence, stagingPath);
                  await assertValidPdf(stagingPath);
                  return;
                }
                // The Duke table starts with no selection, and its global
                // Clear Selections control is not rendered for a one-bill
                // selection. Only clean up when a previous attempt may have
                // left a selection behind.
                if (selectionAttempted) {
                  await portal.clearSelections();
                  await portal.verifySelectionCount(0);
                }
                selectionAttempted = true;
                await portal.selectBatch([bill], options.billingStartMonth, endOfMonth(options.billingStartMonth));
                await portal.verifySelectionCount(1);
                await portal.downloadSelectedBatch(
                  sequence,
                  stagingPath,
                  1,
                  options.billingStartMonth,
                  endOfMonth(options.billingStartMonth),
                );
                await assertValidPdf(stagingPath);
              },
              {
                delaysMs: [2_000],
                onRetry: ({ nextAttempt, error }) => options.logger.warn(
                  `[portal=${options.portalName} account=${output.accountNumber}] ${errorMessage(error)}. Retrying attempt ${nextAttempt}.`,
                ),
              },
            );
            await rename(stagingPath, output.filePath);
            entry.status = 'downloaded';
            entry.message = null;
            options.logger.info(
              `[portal=${options.portalName} partner=${partner.id} account=${output.accountNumber}] Target processing completed with status=downloaded; remainingTargets=${unresolved.size}.`,
            );
          } catch (error) {
            entry.status = 'failed';
            entry.message = errorMessage(error);
            options.logger.error(`[portal=${options.portalName} account=${output.accountNumber}] ${entry.message}`);
          } finally {
            await rm(stagingPath, { force: true }).catch(() => undefined);
            await portal.clearSelections().catch(() => undefined);
            await writeJsonAtomically(reportPath, report);
          }
        };

        // The Duke adapter streams each page's matches through this callback.
        // The returned list remains a compatibility fallback for portal mocks
        // and older adapters that only return matches after scanning.
        const bills = await portal.scanBillsForTargetStartMonth(
          unresolved,
          options.billingStartMonth,
          processMatch,
        );
        options.logger.info(
          `[portal=${options.portalName} partner=${partner.id}] Targeted scan completed: matchedBills=${bills.length} remainingTargets=${unresolved.size}.`,
        );
        for (const bill of bills) await processMatch(bill);
      } catch (error) {
        const detail = `[partner=${partner.id}] ${errorMessage(error)}`;
        partnerFailures.push(detail);
        options.logger.error(`Targeted scan failed ${detail}`);
        await portal.clearSelections().catch(() => undefined);
      }
    }

    for (const accountNumber of unresolved) {
      const entry = reportByAccount.get(accountNumber)!;
      if (partnerFailures.length === 0) {
        entry.status = 'unmatched';
        entry.message = `No downloadable Duke bill was found with a ${formatMonth(options.billingStartMonth)} start.`;
      } else {
        entry.status = 'failed';
        entry.message = `The account could not be fully searched: ${partnerFailures.join('; ')}`;
      }
    }

    report.completedAt = new Date().toISOString();
    await writeJsonAtomically(reportPath, report);
    const counts = countStatuses(report.targets);
    return { reportPath, ...counts, hadFailures: counts.failed > 0 };
  } catch (error) {
    failed = true;
    const wrapped = contextualError('run targeted portal', errorMessage(error), { portal: options.portalName }, error);
    (wrapped as Error & { browser?: Browser | undefined; context?: BrowserContext | undefined }).browser = browser;
    (wrapped as Error & { browser?: Browser | undefined; context?: BrowserContext | undefined }).context = context;
    throw wrapped;
  } finally {
    if (!failed) {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }
}

function choosePartners(accounts: PortalAccount[], current: PortalAccount | undefined, currentOnly: boolean): PortalAccount[] {
  if (currentOnly) return accounts.filter((account) => account.isCurrent);
  return current ? [current, ...accounts.filter((account) => account.id !== current.id)] : accounts;
}

function canReuse(previous: TargetedReportEntry | undefined, bill: Bill, outputFile: string): boolean {
  return previous?.status !== 'failed' && previous?.bill?.uniqueKey === bill.uniqueKey && previous.outputFile === outputFile;
}

function formatMonth(value: Date): string {
  return value.toISOString().slice(0, 7);
}

function endOfMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0));
}

function countStatuses(targets: readonly TargetedReportEntry[]): Omit<TargetedRunResult, 'reportPath' | 'hadFailures'> & { failed: number } {
  return {
    downloaded: targets.filter((target) => target.status === 'downloaded').length,
    reused: targets.filter((target) => target.status === 'reused').length,
    unmatched: targets.filter((target) => target.status === 'unmatched').length,
    failed: targets.filter((target) => target.status === 'failed').length,
  };
}

async function readPriorReport(reportPath: string): Promise<TargetedRunReport | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const value: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
    if (!value || typeof value !== 'object' || !Array.isArray((value as { targets?: unknown }).targets)) return null;
    return value as TargetedRunReport;
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw new Error(`Existing targeted-run.json cannot be read; refusing to overwrite recovery data: ${errorMessage(error)}`);
  }
}
