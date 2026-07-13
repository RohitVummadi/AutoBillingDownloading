import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';

import { mergePdfs } from '../pdf/mergePdfs.js';
import { assertValidPdf, validatePdf } from '../pdf/validatePdf.js';
import type { Bill } from '../types/Bill.js';
import { createBillUniqueKey, deduplicateBills } from '../types/Bill.js';
import type { BillingPortal } from '../types/BillingPortal.js';
import type { BatchManifestRecord, Manifest } from '../types/Manifest.js';
import { createOutputPaths, ensureDirectory } from '../utils/files.js';
import type { Logger } from '../utils/logging.js';
import { contextualError, errorMessage } from '../utils/logging.js';
import { retry } from '../utils/retry.js';
import { compareCalendarDates, parseIsoDate } from '../utils/dates.js';
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
  logger: Logger;
  createPortal(context: PortalFactoryContext): BillingPortal;
  now?: () => Date;
}

export interface RunPortalResult {
  totalMatchingBills: number;
  totalBatches: number;
  manifestPath: string;
  combinedPdfPath: string | null;
}

export async function runPortal(options: RunPortalOptions): Promise<RunPortalResult> {
  const now = options.now ?? (() => new Date());
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let context: BrowserContext | undefined;

  options.logger.info(`Starting portal: ${options.portalName}`);
  try {
    const paths = createOutputPaths(
      options.outputRoot,
      options.portalName,
      options.startDateText,
      options.endDateText,
    );
    await ensureDirectory(paths.runDirectory);

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
    const scannedBills = await portal.scanBills(options.startDate, options.endDate);
    const matchingBills = validateAndDeduplicateBills(scannedBills, options.portalName);
    options.logger.info(`Found ${matchingBills.length} matching bills`);

    const batches = batchBills(matchingBills);
    options.logger.info(`Created ${batches.length} batches`);

    const previousManifest = await readManifest(paths.manifestPath);
    const compatiblePrevious =
      previousManifest &&
      isManifestForRun(
        previousManifest,
        options.portalName,
        options.startDateText,
        options.endDateText,
      )
        ? previousManifest
        : null;
    const manifest = createManifest({
      portal: options.portalName,
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
          record.includedBillUniqueKeys.join('\n') ===
            expectedBatch.map((bill) => bill.uniqueKey).join('\n')
        );
      });
    }
    await writeManifest(paths.manifestPath, manifest);

    if (matchingBills.length === 0) {
      manifest.downloadCompletionTimestamp = now().toISOString();
      await writeManifest(paths.manifestPath, manifest);
      options.logger.info('No matching bills found; no downloads were attempted.');
      return {
        totalMatchingBills: 0,
        totalBatches: 0,
        manifestPath: paths.manifestPath,
        combinedPdfPath: null,
      };
    }

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      if (!batch) throw new Error(`Internal error: batch ${batchIndex + 1} is missing.`);
      const batchNumber = batchIndex + 1;
      const batchPath = paths.batchPdfPath(batchNumber);
      const batchName = paths.batchPdfName(batchNumber);
      const expectedKeys = batch.map((bill) => bill.uniqueKey);
      const previousRecord = findReusableBatchRecord(
        compatiblePrevious,
        batchNumber,
        expectedKeys,
        batchName,
      );
      const existingValidation = previousRecord ? await validatePdf(batchPath) : null;

      let record: BatchManifestRecord;
      if (previousRecord && existingValidation?.valid) {
        record = { ...previousRecord, validationResult: existingValidation };
        options.logger.info(`Validated existing ${batchName}; skipping download`);
      } else {
        record = await retry(
          async () => {
            await portal.clearSelections();
            await portal.verifySelectionCount(0);

            options.logger.info(
              `Selecting batch ${batchNumber} of ${batches.length}`,
            );
            await portal.selectBatch(batch);
            await portal.verifySelectionCount(batch.length);
            options.logger.info(`Selected ${batch.length} of ${batch.length} bills`);

            options.logger.info(
              `Downloading batch ${batchNumber} of ${batches.length}`,
            );
            const downloadedPath = await portal.downloadSelectedBatch(batchNumber, batchPath);
            if (downloadedPath !== batchPath) {
              throw contextualError(
                'download batch',
                'Portal adapter saved the PDF to an unexpected path.',
                { portal: options.portalName, batch: batchNumber },
              );
            }
            const validationResult = await assertValidPdf(batchPath);
            options.logger.info(`Validated ${batchName}`);

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
            onRetry: ({ nextAttempt, delayMs, error }) => {
              options.logger.warn(
                `[portal=${options.portalName} batch=${batchNumber}] batch attempt failed: ${errorMessage(error)}. Retrying with attempt ${nextAttempt} after ${delayMs / 1_000} seconds.`,
              );
            },
          },
        ).catch(async (error: unknown) => {
          const fileValidation = await validatePdf(batchPath);
          const failedRecord: BatchManifestRecord = {
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
          };
          upsertBatchRecord(manifest, failedRecord);
          await writeManifest(paths.manifestPath, manifest);
          throw contextualError(
            'process batch',
            errorMessage(error),
            { portal: options.portalName, batch: batchNumber },
            error,
          );
        });

      }

      upsertBatchRecord(manifest, record);
      await writeManifest(paths.manifestPath, manifest);

      try {
        await portal.clearSelections();
        await portal.verifySelectionCount(0);
      } catch (error) {
        throw contextualError(
          'clear selections after successful batch',
          errorMessage(error),
          { portal: options.portalName, batch: batchNumber },
          error,
        );
      }
      options.logger.info('Cleared all selections');
    }

    const orderedBatchPaths = batches.map((_, index) => paths.batchPdfPath(index + 1));
    options.logger.info(`Merging ${orderedBatchPaths.length} PDFs`);
    await mergePdfs(orderedBatchPaths, paths.combinedPdfPath);
    await assertValidPdf(paths.combinedPdfPath);

    manifest.finalMergedPdfPath = paths.combinedPdfName;
    manifest.downloadCompletionTimestamp = now().toISOString();
    await writeManifest(paths.manifestPath, manifest);
    options.logger.info(`Finished: ${paths.combinedPdfPath}`);

    return {
      totalMatchingBills: matchingBills.length,
      totalBatches: batches.length,
      manifestPath: paths.manifestPath,
      combinedPdfPath: paths.combinedPdfPath,
    };
  } catch (error) {
    throw contextualError(
      'run portal',
      errorMessage(error),
      { portal: options.portalName },
      error,
    );
  } finally {
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

function validateAndDeduplicateBills(bills: readonly Bill[], portalName: string): Bill[] {
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
  }
  return deduplicateBills(bills).sort((left, right) =>
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
