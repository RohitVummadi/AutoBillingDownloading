import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  findReusableBatchRecord,
  readManifest,
} from '../src/core/manifest.js';
import type { Manifest } from '../src/types/Manifest.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('manifest recovery', () => {
  it('treats a missing manifest as a new run', async () => {
    expect(await readManifest(path.join(os.tmpdir(), 'missing-bill-manifest.json'))).toBeNull();
  });

  it('refuses to overwrite corrupt recovery data', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bill-manifest-test-'));
    temporaryDirectories.push(directory);
    const manifestPath = path.join(directory, 'manifest.json');
    await writeFile(manifestPath, '{not-json', 'utf8');
    await expect(readManifest(manifestPath)).rejects.toThrow(/not valid JSON.*refusing/u);
  });

  it('reuses a record only when count, path, validation, and keys match', () => {
    const record = {
      batchNumber: 1,
      numberOfBills: 2,
      batchPdfPath: 'batch-001.pdf',
      downloadTimestamp: '2025-01-01T00:00:00.000Z',
      validationResult: { valid: true, sizeBytes: 2_000, message: 'Valid PDF.' },
      includedBillUniqueKeys: ['key-1', 'key-2'],
    };
    const manifest = {
      portal: 'duke',
      requestedStartDate: '2025-06-01',
      requestedEndDate: '2025-06-30',
      totalMatchingBills: 2,
      totalBatches: 1,
      downloadStartTimestamp: '2025-01-01T00:00:00.000Z',
      downloadCompletionTimestamp: null,
      finalMergedPdfPath: null,
      batches: [record],
      bills: [],
    } satisfies Manifest;

    expect(findReusableBatchRecord(manifest, 1, ['key-1', 'key-2'], 'batch-001.pdf')).toBe(
      record,
    );
    expect(findReusableBatchRecord(manifest, 1, ['key-1'], 'batch-001.pdf')).toBeNull();
  });
});
