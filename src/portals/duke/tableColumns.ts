export interface DukeColumnMap {
  accountNumber: number;
  serviceAddress: number;
  billingCycle: number;
  dueDate?: number;
  amountDue?: number;
  selection?: number;
}

const HEADER_ALIASES = {
  accountNumber: ['account', 'account number', 'account no', 'account #'],
  serviceAddress: ['service address', 'address', 'premise address'],
  billingCycle: ['billing cycle', 'bill cycle', 'billing period', 'service period'],
  dueDate: ['due date', 'payment due date'],
  amountDue: ['amount due', 'balance due', 'current amount due'],
  selection: ['select', 'selection', 'select account', 'select bill'],
} as const;

export function normalizeHeaderText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[_\u00a0]+/gu, ' ')
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

export function mapDukeColumns(headers: readonly string[]): DukeColumnMap {
  const normalized = headers.map(normalizeHeaderText);
  const accountNumber = findColumn(normalized, HEADER_ALIASES.accountNumber);
  const serviceAddress = findColumn(normalized, HEADER_ALIASES.serviceAddress);
  const billingCycle = findColumn(normalized, HEADER_ALIASES.billingCycle);

  const missing: string[] = [];
  if (accountNumber === undefined) missing.push('Account number');
  if (serviceAddress === undefined) missing.push('Service address');
  if (billingCycle === undefined) missing.push('Billing cycle');
  if (
    accountNumber === undefined ||
    serviceAddress === undefined ||
    billingCycle === undefined
  ) {
    throw new Error(
      `Required billing table column${missing.length === 1 ? '' : 's'} not found: ${missing.join(', ')}. Found headers: ${normalized.filter(Boolean).join(', ') || '(none)'}.`,
    );
  }

  const dueDate = findColumn(normalized, HEADER_ALIASES.dueDate);
  const amountDue = findColumn(normalized, HEADER_ALIASES.amountDue);
  const selection = findColumn(normalized, HEADER_ALIASES.selection);

  return {
    accountNumber,
    serviceAddress,
    billingCycle,
    ...(dueDate === undefined ? {} : { dueDate }),
    ...(amountDue === undefined ? {} : { amountDue }),
    ...(selection === undefined ? {} : { selection }),
  };
}

function findColumn(headers: readonly string[], aliases: readonly string[]): number | undefined {
  const normalizedAliases = aliases.map(normalizeHeaderText);
  const exactIndex = headers.findIndex((header) => normalizedAliases.includes(header));
  if (exactIndex >= 0) {
    return exactIndex;
  }

  const partialIndex = headers.findIndex((header) =>
    normalizedAliases.some(
      (alias) => header.length > 0 && (header.includes(alias) || alias.includes(header)),
    ),
  );
  return partialIndex >= 0 ? partialIndex : undefined;
}
