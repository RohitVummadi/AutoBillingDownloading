import { describe, expect, it } from 'vitest';

import { batchBills, MAX_BILLS_PER_BATCH } from '../src/core/batchBills.js';
import type { Bill } from '../src/types/Bill.js';

function bills(count: number): Bill[] {
  return Array.from({ length: count }, (_, index) => ({
    portal: 'duke',
    accountNumber: `account-${index}`,
    serviceAddress: `${index} Main Street`,
    billingCycleStart: '2025-06-01',
    billingCycleEnd: '2025-06-30',
    uniqueKey: `account-${index}|2025-06-01|2025-06-30`,
  }));
}

describe('batchBills', () => {
  it.each([
    [0, []],
    [1, [1]],
    [24, [24]],
    [25, [25]],
    [26, [25, 1]],
    [50, [25, 25]],
    [51, [25, 25, 1]],
    [60, [25, 25, 10]],
  ] as const)('splits %i bills correctly', (count, expectedSizes) => {
    expect(batchBills(bills(count)).map((batch) => batch.length)).toEqual(expectedSizes);
  });

  it('never allows a configured batch above the portal maximum', () => {
    expect(() => batchBills(bills(26), MAX_BILLS_PER_BATCH + 1)).toThrow(/1 to 25/u);
  });
});
