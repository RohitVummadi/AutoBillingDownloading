import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAccountOutputPaths,
  createRunOutputPaths,
  safeChildPath,
  writeJsonAtomically,
} from '../src/utils/files.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('safe and atomic output files', () => {
  it('atomically replaces an existing manifest without leaving temporary files', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bill-files-test-'));
    temporaryDirectories.push(directory);
    const manifestPath = path.join(directory, 'manifest.json');

    await writeJsonAtomically(manifestPath, { version: 1 });
    await writeJsonAtomically(manifestPath, { version: 2 });

    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual({ version: 2 });
    expect(await readdir(directory)).toEqual(['manifest.json']);
  });

  it('rejects traversal and absolute child segments', () => {
    expect(() => safeChildPath('downloads', '..', 'bill.pdf')).toThrow(/Unsafe/u);
    expect(() => safeChildPath('downloads', 'nested/bill.pdf')).toThrow(/Unsafe/u);
    expect(() => safeChildPath('downloads', path.resolve('bill.pdf'))).toThrow(/Unsafe/u);
  });

  it('creates isolated safe output locations for each account and run summary', () => {
    const run = createRunOutputPaths('./downloads', 'duke', '2026-06-01', '2026-07-12');
    const account = createAccountOutputPaths(
      './downloads',
      'duke',
      '2026-06-01',
      '2026-07-12',
      '1102669801',
    );
    expect(run.runSummaryPath).toMatch(/duke[\\/]2026-06-01-to-2026-07-12[\\/]run-summary\.json$/u);
    expect(account.runDirectory).toMatch(/accounts[\\/]account-1102669801$/u);
    expect(() =>
      createAccountOutputPaths('./downloads', 'duke', '2026-06-01', '2026-07-12', '../bad'),
    ).toThrow(/Unsafe account id/u);
  });
});
