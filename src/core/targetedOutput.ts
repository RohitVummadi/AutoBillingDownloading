import path from 'node:path';

import type { AccountMapEntry } from './accountMap.js';

export interface TargetOutput {
  accountNumber: string;
  buildingName: string;
  fileName: string;
  filePath: string;
}

const RESERVED_WINDOWS_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export function createTargetOutputs(outputDirectory: string, entries: readonly AccountMapEntry[]): TargetOutput[] {
  const bases = entries.map((entry) => ({ entry, base: safeBaseName(entry.buildingName) }));
  const counts = new Map<string, number>();
  for (const { base } of bases) counts.set(base.toLocaleLowerCase(), (counts.get(base.toLocaleLowerCase()) ?? 0) + 1);
  return bases.map(({ entry, base }) => {
    const fileName = `${base}${counts.get(base.toLocaleLowerCase())! > 1 ? ` - ${entry.accountNumber}` : ''}.pdf`;
    return { ...entry, fileName, filePath: path.resolve(outputDirectory, fileName) };
  });
}

export function safeBaseName(buildingName: string): string {
  let value = buildingName.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '-').replace(/\s+/gu, ' ').trim();
  value = value.replace(/[. ]+$/gu, '').trim();
  if (value.length === 0) value = 'unnamed-building';
  if (RESERVED_WINDOWS_NAMES.has(value.toLocaleLowerCase())) value = `${value}-`;
  return value;
}
