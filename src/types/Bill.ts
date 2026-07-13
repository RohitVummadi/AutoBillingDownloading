export interface Bill {
  portal: string;
  accountNumber: string;
  serviceAddress: string;
  billingCycleStart: string;
  billingCycleEnd: string;
  dueDate?: string;
  amountDue?: string;
  uniqueKey: string;
}

export function normalizeBillField(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

export function createBillUniqueKey(
  accountNumber: string,
  billingCycleStart: string,
  billingCycleEnd: string,
): string {
  const normalizedAccount = normalizeBillField(accountNumber);
  if (normalizedAccount.length === 0) {
    throw new Error('Cannot create a bill key without an account number.');
  }

  return `${normalizedAccount}|${billingCycleStart}|${billingCycleEnd}`;
}

export function deduplicateBills(bills: readonly Bill[]): Bill[] {
  const seen = new Set<string>();
  const unique: Bill[] = [];

  for (const bill of bills) {
    if (!seen.has(bill.uniqueKey)) {
      seen.add(bill.uniqueKey);
      unique.push(bill);
    }
  }

  return unique;
}
