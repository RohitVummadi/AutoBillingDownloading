import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface OutputPaths {
  outputRoot: string;
  runDirectory: string;
  manifestPath: string;
  combinedPdfPath: string;
  combinedPdfName: string;
  batchPdfPath(batchNumber: number): string;
  batchPdfName(batchNumber: number): string;
}

export interface RunOutputPaths {
  outputRoot: string;
  runDirectory: string;
  runSummaryPath: string;
  finalManifestPath: string;
  finalCombinedPdfPath: string;
  finalCombinedPdfName: string;
}

export function createOutputPaths(
  outputRoot: string,
  portal: string,
  startDate: string,
  endDate: string,
): OutputPaths {
  assertSafeSegment(portal, 'portal');
  assertSafeSegment(startDate, 'start date');
  assertSafeSegment(endDate, 'end date');

  const resolvedRoot = path.resolve(outputRoot);
  const runDirectory = safeChildPath(
    resolvedRoot,
    portal,
    `${startDate}-to-${endDate}`,
  );
  const combinedPdfName = `combined-bills-${startDate}-to-${endDate}.pdf`;

  return {
    outputRoot: resolvedRoot,
    runDirectory,
    manifestPath: safeChildPath(runDirectory, 'manifest.json'),
    combinedPdfPath: safeChildPath(runDirectory, combinedPdfName),
    combinedPdfName,
    batchPdfPath(batchNumber: number): string {
      return safeChildPath(runDirectory, formatBatchFileName(batchNumber));
    },
    batchPdfName(batchNumber: number): string {
      return formatBatchFileName(batchNumber);
    },
  };
}

export function createRunOutputPaths(
  outputRoot: string,
  portal: string,
  startDate: string,
  endDate: string,
): RunOutputPaths {
  assertSafeSegment(portal, 'portal');
  assertSafeSegment(startDate, 'start date');
  assertSafeSegment(endDate, 'end date');
  const resolvedRoot = path.resolve(outputRoot);
  const runDirectory = safeChildPath(resolvedRoot, portal, `${startDate}-to-${endDate}`);
  const finalCombinedPdfName = `combined-bills-${startDate}-to-${endDate}.pdf`;
  return {
    outputRoot: resolvedRoot,
    runDirectory,
    runSummaryPath: safeChildPath(runDirectory, 'run-summary.json'),
    finalManifestPath: safeChildPath(runDirectory, 'manifest.json'),
    finalCombinedPdfPath: safeChildPath(runDirectory, finalCombinedPdfName),
    finalCombinedPdfName,
  };
}

export function createAccountOutputPaths(
  outputRoot: string,
  portal: string,
  startDate: string,
  endDate: string,
  accountId: string,
): OutputPaths {
  assertSafeSegment(accountId, 'account id');
  const root = createRunOutputPaths(outputRoot, portal, startDate, endDate);
  const runDirectory = safeChildPath(root.runDirectory, 'accounts', `account-${accountId}`);
  const combinedPdfName = `combined-bills-${startDate}-to-${endDate}.pdf`;
  return {
    outputRoot: root.outputRoot,
    runDirectory,
    manifestPath: safeChildPath(runDirectory, 'manifest.json'),
    combinedPdfPath: safeChildPath(runDirectory, combinedPdfName),
    combinedPdfName,
    batchPdfPath(batchNumber: number): string {
      return safeChildPath(runDirectory, formatBatchFileName(batchNumber));
    },
    batchPdfName(batchNumber: number): string {
      return formatBatchFileName(batchNumber);
    },
  };
}

export async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

export async function writeBufferAtomically(
  destination: string,
  contents: Uint8Array,
): Promise<void> {
  await ensureDirectory(path.dirname(destination));
  const temporaryPath = `${destination}.${process.pid}.${Date.now()}.tmp`;

  try {
    await writeFile(temporaryPath, contents, { flag: 'wx' });
    // The temporary file is in the same directory, so rename replaces the
    // destination atomically while preserving the old file if rename fails.
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function writeJsonAtomically(destination: string, value: unknown): Promise<void> {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await writeBufferAtomically(destination, Buffer.from(json, 'utf8'));
}

export function safeChildPath(parent: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      path.isAbsolute(segment) ||
      segment.includes('/') ||
      segment.includes('\\') ||
      segment.includes('\0')
    ) {
      throw new Error(`Unsafe output path segment "${segment}".`);
    }
  }

  const resolvedParent = path.resolve(parent);
  const candidate = path.resolve(resolvedParent, ...segments);
  const relative = path.relative(resolvedParent, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to create an output path outside the configured output directory.');
  }
  return candidate;
}

function assertSafeSegment(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value)) {
    throw new Error(`Unsafe ${label} path value "${value}".`);
  }
}

function formatBatchFileName(batchNumber: number): string {
  if (!Number.isInteger(batchNumber) || batchNumber < 1) {
    throw new Error(`Invalid batch number ${batchNumber}.`);
  }
  return `batch-${batchNumber.toString().padStart(3, '0')}.pdf`;
}
