import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface AccountMapEntry {
  accountNumber: string;
  buildingName: string;
  rowNumber: number;
}

export interface AccountMap {
  sourcePath: string;
  entries: AccountMapEntry[];
  byAccountNumber: ReadonlyMap<string, AccountMapEntry>;
}

/** Reads the two required columns without assigning object properties to duplicate CSV headers. */
export async function readAccountMap(filePath: string): Promise<AccountMap> {
  const sourcePath = path.resolve(filePath);
  let contents: string;
  try {
    contents = await readFile(sourcePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read --account-map file "${sourcePath}": ${message(error)}`);
  }

  const rows = parseCsv(contents);
  if (rows.length === 0) throw new Error('Account-map CSV is empty.');
  const header = rows[0]!.map((value) => value.trim().toLowerCase());
  const accountColumn = header.indexOf('account number');
  const buildingColumn = header.indexOf('building name');
  if (accountColumn === -1 || buildingColumn === -1) {
    throw new Error('Account-map CSV must contain "Account Number" and "Building Name" columns.');
  }

  const byAccountNumber = new Map<string, AccountMapEntry>();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.every((value) => value.trim().length === 0)) continue;
    const rowNumber = index + 1;
    const accountNumber = (row[accountColumn] ?? '').trim();
    const buildingName = (row[buildingColumn] ?? '').trim();
    if (accountNumber.length === 0 || buildingName.length === 0) {
      throw new Error(`Account-map CSV row ${rowNumber} requires both Account Number and Building Name.`);
    }
    if (!/^\d{6,}$/u.test(accountNumber)) {
      throw new Error(`Account-map CSV row ${rowNumber} has an invalid Account Number "${accountNumber}".`);
    }
    const existing = byAccountNumber.get(accountNumber);
    if (existing) {
      if (existing.buildingName !== buildingName) {
        throw new Error(
          `Account-map CSV maps account ${accountNumber} to both "${existing.buildingName}" and "${buildingName}".`,
        );
      }
      continue;
    }
    byAccountNumber.set(accountNumber, { accountNumber, buildingName, rowNumber });
  }

  if (byAccountNumber.size === 0) throw new Error('Account-map CSV contains no usable account rows.');
  return { sourcePath, entries: [...byAccountNumber.values()], byAccountNumber };
}

export function parseCsv(contents: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let atFieldStart = true;
  const source = contents.replace(/^\uFEFF/u, '');

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else if (character === ',') {
      row.push(field);
      field = '';
      atFieldStart = true;
    } else if (character === '\n') {
      row.push(field.replace(/\r$/u, ''));
      rows.push(row);
      row = [];
      field = '';
      atFieldStart = true;
    } else {
      field += character;
      atFieldStart = false;
    }
  }
  if (quoted) throw new Error('Account-map CSV has an unterminated quoted field.');
  if (field.length > 0 || row.length > 0) rows.push([...row, field.replace(/\r$/u, '')]);
  return rows;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
