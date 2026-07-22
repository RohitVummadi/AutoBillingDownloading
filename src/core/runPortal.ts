import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

import { mergePdfs } from '../pdf/mergePdfs.js';
import { assertValidPdf, validatePdf } from '../pdf/validatePdf.js';
import type { Bill } from '../types/Bill.js';
import { createBillUniqueKey, deduplicateBills } from '../types/Bill.js';
import type { BillingPortal } from '../types/BillingPortal.js';
import type {
  AccountRunSummary,
  BatchManifestRecord,
  FinalRunManifest,
  Manifest,
  RunSummary,
} from '../types/Manifest.js';
import type { PortalAccount } from '../types/PortalAccount.js';
import {
  createAccountOutputPaths,
  createRunOutputPaths,
  ensureDirectory,
  writeJsonAtomically,
} from '../utils/files.js';
import type { Logger } from '../utils/logging.js';
import { contextualError, errorMessage, redactSensitiveText } from '../utils/logging.js';
import { BATCH_RETRY_DELAYS_MS, retry } from '../utils/retry.js';
import { compareCalendarDates, parseIsoDate } from '../utils/dates.js';
import { isBillingCycleStartInRange } from '../utils/dates.js';
import { batchBills } from './batchBills.js';
import {
  createManifest,
  findReusableBatchRecord,
  isManifestForRun,
  readManifest,
  writeManifest,
} from './manifest.js';

export interface PortalFactoryContext {
  page: Page;
  context: BrowserContext;
}

export interface RunPortalOptions {
  portalName: string;
  startDate: Date;
  startDateText: string;
  endDate: Date;
  endDateText: string;
  outputRoot: string;
  headless: boolean;
  currentAccountOnly: boolean;
  logger: Logger;
  createPortal(context: PortalFactoryContext): BillingPortal;
  now?: () => Date;
}

export interface RunPortalResult {
  totalMatchingBills: number;
  totalBatches: number;
  runSummaryPath: string;
  accounts: AccountRunSummary[];
  hadFailures: boolean;
}

export async function runPortal(options: RunPortalOptions): Promise<RunPortalResult> {
  const now = options.now ?? (() => new Date());
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let failed = false;

  options.logger.info(`Starting portal: ${options.portalName}`);
  try {
    const runPaths = createRunOutputPaths(
      options.outputRoot,
      options.portalName,
      options.startDateText,
      options.endDateText,
    );
    await ensureDirectory(runPaths.runDirectory);
    options.logger.info(`Downloaded files will be saved to: ${runPaths.runDirectory}`);

    browser = await chromium.launch({ headless: options.headless });
    context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const portal = options.createPortal({ page, context });
    if (portal.name !== options.portalName) {
      throw new Error(
        `Portal factory returned "${portal.name}" while "${options.portalName}" was requested.`,
      );
    }

    await portal.login();
    await portal.navigateToBills();
    const discoveredAccounts = await portal.listAccounts();
    const initialCurrentAccount = discoveredAccounts.find((account) => account.isCurrent);
    const accounts = options.currentAccountOnly
      ? discoveredAccounts.filter((account) => account.isCurrent)
      : initialCurrentAccount
        ? [
            initialCurrentAccount,
            ...discoveredAccounts.filter((account) => account.id !== initialCurrentAccount.id),
          ]
        : discoveredAccounts;
    if (accounts.length === 0) {
      throw new Error('No current Business Partner account was identified.');
    }
    const summary: RunSummary = {
      portal: options.portalName,
      requestedStartDate: options.startDateText,
      requestedEndDate: options.endDateText,
      startedAt: now().toISOString(),
      completedAt: null,
      accounts: accounts.map((account) => ({
        account,
        status: 'pending',
        totalMatchingBills: 0,
        totalBatches: 0,
        manifestPath: null,
        combinedPdfPath: null,
        failureMessage: null,
      })),
    };
    await writeJsonAtomically(runPaths.runSummaryPath, summary);

    let activeAccountId = initialCurrentAccount?.id;
    const uniqueBills = new Map<string, Bill>();
    const billSourcePartners = new Map<string, Set<string>>();
    for (let index = 0; index < accounts.length; index += 1) {
      const account = accounts[index]!;
      const record = summary.accounts[index]!;
      options.logger.info(`Processing Business Partner ${index + 1}/${accounts.length}: ${account.id} ${account.label}`);
      try {
        const accountPaths = createAccountOutputPaths(
          options.outputRoot,
          options.portalName,
          options.startDateText,
          options.endDateText,
          account.id,
        );
        record.manifestPath = accountPaths.manifestPath;
        await ensureDirectory(accountPaths.runDirectory);
        if ((await readManifest(accountPaths.manifestPath)) === null) {
          await writeManifest(
            accountPaths.manifestPath,
            createManifest({
              portal: options.portalName,
              account,
              requestedStartDate: options.startDateText,
              requestedEndDate: options.endDateText,
              batches: [],
              batchPdfName: accountPaths.batchPdfName,
              startedAt: now().toISOString(),
            }),
          );
        }
        if (activeAccountId !== account.id) {
          try {
            await portal.activateAccount(account);
          } catch (firstError) {
            options.logger.warn(
              `[portal=${options.portalName} account=${account.id}] partner readiness attempt 1 failed: ${errorMessage(firstError)}. Reloading once before retry.`,
            );
            // Controlled recovery only: the adapter has already confirmed the
            // selector before it fails readiness, so reload the billing route
            // and retry the same requested partner once.
            await portal.navigateToBills();
            await portal.activateAccount(account);
          }
          activeAccountId = account.id;
        }
        const result = await processAccount(
          portal,
          account,
          options,
          now,
          uniqueBills,
          billSourcePartners,
        );
        record.status = 'completed';
        record.totalMatchingBills = result.totalMatchingBills;
        record.totalBatches = result.totalBatches;
        record.manifestPath = result.manifestPath;
        record.combinedPdfPath = result.combinedPdfPath;
      } catch (error) {
        record.status = 'failed';
        record.failureMessage = redactSensitiveText(errorMessage(error), []);
        if (record.manifestPath !== null) {
          await markAccountManifestFailed(record.manifestPath, record.failureMessage).catch((manifestError: unknown) => {
            options.logger.warn(
              `[portal=${options.portalName} account=${account.id}] manifest failure checkpoint: ${errorMessage(manifestError)}`,
            );
          });
        }
        options.logger.error(`[portal=${options.portalName} account=${account.id}] ${record.failureMessage}`);
        await portal.clearSelections().catch((clearError: unknown) => {
          options.logger.warn(`[portal=${options.portalName} account=${account.id}] cleanup: ${errorMessage(clearError)}`);
        });
      }
      await writeJsonAtomically(runPaths.runSummaryPath, summary);
    }

    summary.completedAt = now().toISOString();
    const finalBatches = batchBills([...uniqueBills.values()]);
    const completedPdfPaths = summary.accounts
      .map((account) => account.combinedPdfPath)
      .filter((path): path is string => path !== null);
    const finalMergedPdfPath =
      completedPdfPaths.length === 0 ? null : runPaths.finalCombinedPdfPath;
    if (finalMergedPdfPath !== null) {
      await mergePdfs(completedPdfPaths, finalMergedPdfPath);
      await assertValidPdf(finalMergedPdfPath);
    }
    summary.totalUniqueMatchingBills = uniqueBills.size;
    summary.finalMergedPdfPath = finalMergedPdfPath === null ? null : runPaths.finalCombinedPdfName;
    const finalManifest: FinalRunManifest = {
      portal: options.portalName,
      requestedStartDate: options.startDateText,
      requestedEndDate: options.endDateText,
      totalUniqueMatchingBills: uniqueBills.size,
      totalBatches: finalBatches.length,
      finalMergedPdfPath: summary.finalMergedPdfPath ?? null,
      bills: [...uniqueBills.values()].map((bill) => ({
        ...bill,
        sourcePartnerIds: [...(billSourcePartners.get(bill.uniqueKey) ?? [])],
      })),
      accounts: summary.accounts,
    };
    await writeJsonAtomically(runPaths.finalManifestPath, finalManifest);
    await writeJsonAtomically(runPaths.runSummaryPath, summary);
    const hadFailures = summary.accounts.some((account) => account.status === 'failed');
    const totalMatchingBills = uniqueBills.size;
    const totalBatches = finalBatches.length;
    options.logger.info(`Completed ${summary.accounts.length - summary.accounts.filter((account) => account.status === 'completed').length} failed account(s); summary: ${runPaths.runSummaryPath}`);
    return { totalMatchingBills, totalBatches, runSummaryPath: runPaths.runSummaryPath, accounts: summary.accounts, hadFailures };
  } catch (error) {
    failed = true;
    const wrapped = contextualError(
      'run portal',
      errorMessage(error),
      { portal: options.portalName },
      error,
    );
    // Attach the live browser so the caller can keep it open for inspection
    // and close it only after the user is done.
    (wrapped as Error & { browser?: Browser | undefined; context?: BrowserContext | undefined }).browser =
      browser;
    (wrapped as Error & { browser?: Browser | undefined; context?: BrowserContext | undefined }).context =
      context;
    throw wrapped;
  } finally {
    if (!failed) {
      // Keep headed runs open so the user can inspect the final billing page
      // and manually close the browser when finished.
      if (!options.headless && process.stdin.isTTY && browser) {
        options.logger.info(
          'Run complete. Close the browser window, or press Enter here, to exit.',
        );
        await waitForBrowserClose(browser);
      }
      if (context) {
        await context.close().catch((error: unknown) => {
          options.logger.warn(
            `[portal=${options.portalName}] close browser context: ${errorMessage(error)}.`,
          );
        });
      }
      if (browser) {
        await browser.close().catch((error: unknown) => {
          options.logger.warn(
            `[portal=${options.portalName}] close browser: ${errorMessage(error)}.`,
          );
        });
      }
    }
  }
}

async function waitForBrowserClose(browser: Browser): Promise<void> {
  if (!browser.isConnected()) return;

  await new Promise<void>((resolve) => {
    const onInput = (): void => finish();
    const onDisconnected = (): void => finish();
    const finish = (): void => {
      browser.off('disconnected', onDisconnected);
      process.stdin.off('data', onInput);
      process.stdin.pause();
      resolve();
    };

    browser.once('disconnected', onDisconnected);
    process.stdin.resume();
    process.stdin.once('data', onInput);
  });
}

interface AccountProcessResult {
  totalMatchingBills: number;
  totalBatches: number;
  manifestPath: string;
  combinedPdfPath: string | null;
  matchingBills: Bill[];
}

async function processAccount(
  portal: BillingPortal,
  account: PortalAccount,
  options: RunPortalOptions,
  now: () => Date,
  uniqueBills: Map<string, Bill>,
  billSourcePartners: Map<string, Set<string>>,
): Promise<AccountProcessResult> {
  const paths = createAccountOutputPaths(
    options.outputRoot,
    options.portalName,
    options.startDateText,
    options.endDateText,
    account.id,
  );
  await ensureDirectory(paths.runDirectory);
  const scannedBills = await portal.scanBills(options.startDate, options.endDate);
  const scannedMatchingBills = validateAndDeduplicateBills(
    scannedBills,
    options.portalName,
    options.startDate,
    options.endDate,
  );
  const matchingBills: Bill[] = [];
  for (const bill of scannedMatchingBills) {
    const sources = billSourcePartners.get(bill.uniqueKey) ?? new Set<string>();
    sources.add(account.id);
    billSourcePartners.set(bill.uniqueKey, sources);
    if (uniqueBills.has(bill.uniqueKey)) {
      options.logger.info(
        `[portal=${options.portalName} account=${account.id}] Duplicate bill retained from another partner: ${bill.uniqueKey}.`,
      );
      continue;
    }
    uniqueBills.set(bill.uniqueKey, bill);
    matchingBills.push(bill);
  }
  options.logger.info(
    `[portal=${options.portalName} account=${account.id}] Found ${scannedMatchingBills.length} matching bill(s); ${matchingBills.length} unique bill(s) will download.`,
  );
  const batches = batchBills(matchingBills);
  const previousManifest = await readManifest(paths.manifestPath);
  const compatiblePrevious =
    previousManifest &&
    isManifestForRun(
      previousManifest,
      options.portalName,
      options.startDateText,
      options.endDateText,
      account.id,
    )
      ? previousManifest
      : null;
  const manifest = createManifest({
    portal: options.portalName,
    account,
    requestedStartDate: options.startDateText,
    requestedEndDate: options.endDateText,
    batches,
    batchPdfName: paths.batchPdfName,
    startedAt: compatiblePrevious?.downloadStartTimestamp ?? now().toISOString(),
  });
  if (compatiblePrevious) {
    manifest.batches = compatiblePrevious.batches.filter((record) => {
      const expectedBatch = batches[record.batchNumber - 1];
      return (
        expectedBatch !== undefined &&
        record.numberOfBills === expectedBatch.length &&
        record.batchPdfPath === paths.batchPdfName(record.batchNumber) &&
        record.includedBillUniqueKeys.join('\n') === expectedBatch.map((bill) => bill.uniqueKey).join('\n')
      );
    });
  }
  await writeManifest(paths.manifestPath, manifest);

  if (matchingBills.length === 0) {
    manifest.accountStatus = 'completed';
    manifest.downloadCompletionTimestamp = now().toISOString();
    await writeManifest(paths.manifestPath, manifest);
    return {
      totalMatchingBills: 0,
      totalBatches: 0,
      manifestPath: paths.manifestPath,
      combinedPdfPath: null,
      matchingBills,
    };
  }

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    if (!batch) throw new Error(`Internal error: batch ${batchIndex + 1} is missing.`);
    const batchNumber = batchIndex + 1;
    const batchPath = paths.batchPdfPath(batchNumber);
    const batchName = paths.batchPdfName(batchNumber);
    const expectedKeys = batch.map((bill) => bill.uniqueKey);
    const previousRecord = findReusableBatchRecord(compatiblePrevious, batchNumber, expectedKeys, batchName);
    const existingValidation = previousRecord ? await validatePdf(batchPath) : null;
    let record: BatchManifestRecord;
    if (previousRecord && existingValidation?.valid) {
      record = { ...previousRecord, validationResult: existingValidation };
      options.logger.info(`[portal=${options.portalName} account=${account.id}] Reused validated ${batchName}.`);
    } else {
      record = await retry(
        async () => {
          options.logger.info(
            `[portal=${options.portalName} account=${account.id} batch=${batchNumber}] Batch start: expectedBillCount=${batch.length}; expectedKeys=${expectedKeys.join(',')}.`,
          );
          await portal.clearSelections();
          await portal.verifySelectionCount(0);
          await portal.selectBatch(batch, options.startDate, options.endDate);
          await portal.verifySelectionCount(batch.length);
          options.logger.info(
            `[portal=${options.portalName} account=${account.id} batch=${batchNumber}] Bulk download start.`,
          );
          const downloadedPath = await portal.downloadSelectedBatch(
            batchNumber,
            batchPath,
            batch.length,
            options.startDate,
            options.endDate,
          );
          if (downloadedPath !== batchPath) {
            throw contextualError('download batch', 'Portal adapter saved the PDF to an unexpected path.', {
              portal: options.portalName,
              account: account.id,
              batch: batchNumber,
            });
          }
          const validationResult = await assertValidPdf(batchPath);
          options.logger.info(
            `[portal=${options.portalName} account=${account.id} batch=${batchNumber}] Bulk download complete: pdf=${batchPath}; valid=${validationResult.valid}; ${validationResult.message}`,
          );
          return {
            batchNumber,
            numberOfBills: batch.length,
            batchPdfPath: batchName,
            downloadTimestamp: now().toISOString(),
            validationResult,
            includedBillUniqueKeys: expectedKeys,
          };
        },
        {
          // A Duke bulk-download failure must reselect the whole batch once;
          // retry() re-enters the operation above, which clears and returns to
          // page 1 through selectBatch before it clicks Download View again.
          delaysMs: [BATCH_RETRY_DELAYS_MS[0]],
          onRetry: ({ nextAttempt, delayMs, error }) => {
            options.logger.warn(
              `[portal=${options.portalName} account=${account.id} batch=${batchNumber}] ${errorMessage(error)}. Retrying attempt ${nextAttempt} after ${delayMs / 1_000}s.`,
            );
          },
        },
      ).catch(async (error: unknown) => {
        const fileValidation = await validatePdf(batchPath);
        upsertBatchRecord(manifest, {
          batchNumber,
          numberOfBills: batch.length,
          batchPdfPath: batchName,
          downloadTimestamp: now().toISOString(),
          validationResult: {
            valid: false,
            sizeBytes: fileValidation.sizeBytes,
            message: fileValidation.valid
              ? 'Batch processing failed before a successful checkpoint was recorded.'
              : fileValidation.message,
          },
          includedBillUniqueKeys: expectedKeys,
        });
        await writeManifest(paths.manifestPath, manifest);
        throw contextualError('process batch', errorMessage(error), {
          portal: options.portalName,
          account: account.id,
          batch: batchNumber,
        }, error);
      });
    }
    upsertBatchRecord(manifest, record);
    await writeManifest(paths.manifestPath, manifest);
    await portal.clearSelections();
    await portal.verifySelectionCount(0);
    options.logger.info(
      `[portal=${options.portalName} account=${account.id} batch=${batchNumber}] Cleanup complete; selected-count=0.`,
    );
  }

  const orderedBatchPaths = batches.map((_, index) => paths.batchPdfPath(index + 1));
  await mergePdfs(orderedBatchPaths, paths.combinedPdfPath);
  await assertValidPdf(paths.combinedPdfPath);
  manifest.finalMergedPdfPath = paths.combinedPdfName;
  manifest.accountStatus = 'completed';
  manifest.downloadCompletionTimestamp = now().toISOString();
  await writeManifest(paths.manifestPath, manifest);
  return {
    totalMatchingBills: matchingBills.length,
    totalBatches: batches.length,
    manifestPath: paths.manifestPath,
    combinedPdfPath: paths.combinedPdfPath,
    matchingBills,
  };
}

async function markAccountManifestFailed(manifestPath: string, failureMessage: string): Promise<void> {
  const manifest = await readManifest(manifestPath);
  if (manifest === null) return;
  manifest.accountStatus = 'failed';
  manifest.failureMessage = failureMessage;
  await writeManifest(manifestPath, manifest);
}

function validateAndDeduplicateBills(
  bills: readonly Bill[],
  portalName: string,
  requestedStart: Date,
  requestedEnd: Date,
): Bill[] {
  const matchingBills: Bill[] = [];
  for (const bill of bills) {
    if (bill.portal !== portalName) {
      throw contextualError(
        'validate scanned bills',
        `Portal adapter returned a bill owned by "${bill.portal}".`,
        { portal: portalName, account: bill.accountNumber },
      );
    }
    let cycleStart: Date;
    let cycleEnd: Date;
    try {
      cycleStart = parseIsoDate(bill.billingCycleStart, 'billing cycle start');
      cycleEnd = parseIsoDate(bill.billingCycleEnd, 'billing cycle end');
    } catch (error) {
      throw contextualError(
        'validate scanned bills',
        errorMessage(error),
        {
          portal: portalName,
          account: bill.accountNumber,
          billingCycle: `${bill.billingCycleStart}-to-${bill.billingCycleEnd}`,
        },
        error,
      );
    }
    if (compareCalendarDates(cycleStart, cycleEnd) > 0) {
      throw contextualError(
        'validate scanned bills',
        'Billing cycle start is later than billing cycle end.',
        {
          portal: portalName,
          account: bill.accountNumber,
          billingCycle: `${bill.billingCycleStart}-to-${bill.billingCycleEnd}`,
        },
      );
    }
    const expectedKey = createBillUniqueKey(
      bill.accountNumber,
      bill.billingCycleStart,
      bill.billingCycleEnd,
    );
    if (bill.uniqueKey !== expectedKey) {
      throw contextualError(
        'validate scanned bills',
        'Portal adapter returned a bill with an inconsistent unique key.',
        {
          portal: portalName,
          account: bill.accountNumber,
          billingCycle: `${bill.billingCycleStart}-to-${bill.billingCycleEnd}`,
        },
      );
    }
    if (
      !isBillingCycleStartInRange(
        cycleStart,
        requestedStart,
        requestedEnd,
      )
    ) {
      continue;
    }
    matchingBills.push(bill);
  }
  return deduplicateBills(matchingBills).sort((left, right) =>
    left.uniqueKey.localeCompare(right.uniqueKey, 'en'),
  );
}

function upsertBatchRecord(manifest: Manifest, record: BatchManifestRecord): void {
  const existingIndex = manifest.batches.findIndex(
    (candidate) => candidate.batchNumber === record.batchNumber,
  );
  if (existingIndex >= 0) {
    manifest.batches[existingIndex] = record;
  } else {
    manifest.batches.push(record);
  }
  manifest.batches.sort((left, right) => left.batchNumber - right.batchNumber);
}
