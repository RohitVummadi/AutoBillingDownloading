import { readFile } from 'node:fs/promises';

import type { Bill } from '../types/Bill.js';
import type {
  BatchManifestRecord,
  BillManifestRecord,
  Manifest,
} from '../types/Manifest.js';
import { writeJsonAtomically } from '../utils/files.js';

export interface ManifestInput {
  portal: string;
  requestedStartDate: string;
  requestedEndDate: string;
  batches: readonly (readonly Bill[])[];
  batchPdfName(batchNumber: number): string;
  startedAt: string;
}

export function createManifest(input: ManifestInput): Manifest {
  const billRecords: BillManifestRecord[] = [];
  input.batches.forEach((batch, batchIndex) => {
    const batchNumber = batchIndex + 1;
    const batchPdfPath = input.batchPdfName(batchNumber);
    for (const bill of batch) {
      billRecords.push({ ...bill, batchNumber, batchPdfPath });
    }
  });

  return {
    portal: input.portal,
    requestedStartDate: input.requestedStartDate,
    requestedEndDate: input.requestedEndDate,
    totalMatchingBills: billRecords.length,
    totalBatches: input.batches.length,
    downloadStartTimestamp: input.startedAt,
    downloadCompletionTimestamp: null,
    finalMergedPdfPath: null,
    batches: [],
    bills: billRecords,
  };
}

export async function writeManifest(filePath: string, manifest: Manifest): Promise<void> {
  await writeJsonAtomically(filePath, manifest);
}

export async function readManifest(filePath: string): Promise<Manifest | null> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Existing manifest.json cannot be read; refusing to overwrite recovery data.', {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error('Existing manifest.json is not valid JSON; refusing to overwrite it.', {
      cause: error,
    });
  }
  if (!isManifest(parsed)) {
    throw new Error('Existing manifest.json has an unsupported or incomplete structure; refusing to overwrite it.');
  }
  return parsed;
}

export function isManifestForRun(
  manifest: Manifest,
  portal: string,
  startDate: string,
  endDate: string,
): boolean {
  return (
    manifest.portal === portal &&
    manifest.requestedStartDate === startDate &&
    manifest.requestedEndDate === endDate
  );
}

export function findReusableBatchRecord(
  manifest: Manifest | null,
  batchNumber: number,
  expectedKeys: readonly string[],
  expectedPdfName: string,
): BatchManifestRecord | null {
  const record = manifest?.batches.find((candidate) => candidate.batchNumber === batchNumber);
  if (
    !record ||
    !record.validationResult.valid ||
    record.numberOfBills !== expectedKeys.length ||
    record.batchPdfPath !== expectedPdfName ||
    record.includedBillUniqueKeys.join('\n') !== expectedKeys.join('\n')
  ) {
    return null;
  }
  return record;
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Manifest>;
  return (
    typeof candidate.portal === 'string' &&
    typeof candidate.requestedStartDate === 'string' &&
    typeof candidate.requestedEndDate === 'string' &&
    typeof candidate.totalMatchingBills === 'number' &&
    typeof candidate.totalBatches === 'number' &&
    typeof candidate.downloadStartTimestamp === 'string' &&
    (candidate.downloadCompletionTimestamp === null ||
      typeof candidate.downloadCompletionTimestamp === 'string') &&
    (candidate.finalMergedPdfPath === null ||
      typeof candidate.finalMergedPdfPath === 'string') &&
    Array.isArray(candidate.batches) &&
    candidate.batches.every(isBatchManifestRecord) &&
    Array.isArray(candidate.bills) &&
    candidate.bills.every(isBillManifestRecord)
  );
}

function isBatchManifestRecord(value: unknown): value is BatchManifestRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BatchManifestRecord>;
  const validation = candidate.validationResult;
  return (
    typeof candidate.batchNumber === 'number' &&
    typeof candidate.numberOfBills === 'number' &&
    typeof candidate.batchPdfPath === 'string' &&
    typeof candidate.downloadTimestamp === 'string' &&
    Array.isArray(candidate.includedBillUniqueKeys) &&
    candidate.includedBillUniqueKeys.every((key) => typeof key === 'string') &&
    typeof validation === 'object' &&
    validation !== null &&
    typeof validation.valid === 'boolean' &&
    typeof validation.sizeBytes === 'number' &&
    typeof validation.message === 'string'
  );
}

function isBillManifestRecord(value: unknown): value is BillManifestRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BillManifestRecord>;
  return (
    typeof candidate.portal === 'string' &&
    typeof candidate.accountNumber === 'string' &&
    typeof candidate.serviceAddress === 'string' &&
    typeof candidate.billingCycleStart === 'string' &&
    typeof candidate.billingCycleEnd === 'string' &&
    typeof candidate.uniqueKey === 'string' &&
    typeof candidate.batchNumber === 'number' &&
    typeof candidate.batchPdfPath === 'string' &&
    (candidate.dueDate === undefined || typeof candidate.dueDate === 'string') &&
    (candidate.amountDue === undefined || typeof candidate.amountDue === 'string')
  );
}
