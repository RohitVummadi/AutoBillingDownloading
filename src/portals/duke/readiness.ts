import { parseBillingCycle } from '../../utils/dates.js';

/** Excludes Duke's skeleton/header/placeholder rows from readiness decisions. */
export function isRealDukeBillRow(
  accountNumber: string,
  serviceAddress: string,
  billingCycle: string,
): boolean {
  if (!/\d{6,}/u.test(accountNumber) || serviceAddress.trim().length === 0) return false;
  try {
    parseBillingCycle(billingCycle);
    return true;
  } catch {
    return false;
  }
}

export function dukeEmptyStateMessage(tableText: string): string | null {
  const match = /(?:no (?:bills|records|results|data)|no billing activity)/iu.exec(tableText);
  return match?.[0] ?? null;
}
