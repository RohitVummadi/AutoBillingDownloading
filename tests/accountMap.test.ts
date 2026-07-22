import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readAccountMap } from '../src/core/accountMap.js';
import { createTargetOutputs, safeBaseName } from '../src/core/targetedOutput.js';
import { normalizeAccountNumber } from '../src/types/Bill.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function csv(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'duke-account-map-'));
  directories.push(directory);
  const filePath = path.join(directory, 'meters.csv');
  await writeFile(filePath, contents, 'utf8');
  return filePath;
}

describe('account-map CSV parsing', () => {
  it('matches Duke account display formatting to the numeric CSV account', () => {
    expect(normalizeAccountNumber('9 100-297-95124')).toBe('910029795124');
  });

  it('reads quoted building names while ignoring duplicate unrelated headers and blank rows', async () => {
    const map = await readAccountMap(await csv([
      'Account Number,Building Name,Amount,Amount',
      '910000000001,"Cherry Road, Fish Pond",,',
      '',
      '910000000002,Main Meter,,',
    ].join('\n')));

    expect(map.entries).toEqual([
      { accountNumber: '910000000001', buildingName: 'Cherry Road, Fish Pond', rowNumber: 2 },
      { accountNumber: '910000000002', buildingName: 'Main Meter', rowNumber: 4 },
    ]);
  });

  it('rejects malformed required values and conflicting account mappings', async () => {
    await expect(readAccountMap(await csv('Account Number,Building Name\nnot-a-number,Main\n'))).rejects.toThrow(/invalid Account Number/u);
    await expect(readAccountMap(await csv('Account Number,Building Name\n910000000001,One\n910000000001,Two\n'))).rejects.toThrow(/both/u);
  });
});

describe('target output names', () => {
  it('sanitizes Windows-invalid characters and uses account suffixes only for collisions', () => {
    const outputs = createTargetOutputs('C:\\bills', [
      { accountNumber: '910000000001', buildingName: 'A/B', rowNumber: 2 },
      { accountNumber: '910000000002', buildingName: 'A:B', rowNumber: 3 },
      { accountNumber: '910000000003', buildingName: 'CON', rowNumber: 4 },
    ]);
    expect(outputs.map((output) => output.fileName)).toEqual([
      'A-B - 910000000001.pdf',
      'A-B - 910000000002.pdf',
      'CON-.pdf',
    ]);
    expect(safeBaseName('  Building.  ')).toBe('Building');
  });
});
