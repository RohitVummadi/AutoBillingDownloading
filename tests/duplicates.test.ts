import { describe, expect, it } from 'vitest';

import {
  createBillUniqueKey,
  deduplicateBills,
  type Bill,
} from '../src/types/Bill.js';

function bill(uniqueKey: string, accountNumber = '00123'): Bill {
  return {
    portal: 'duke',
    accountNumber,
    serviceAddress: '1 Main Street',
    billingCycleStart: '2025-06-01',
    billingCycleEnd: '2025-06-30',
    uniqueKey,
  };
}

describe('bill identity and duplicates', () => {
  it('uses account number plus both cycle dates as the key', () => {
    expect(createBillUniqueKey('  00123  ', '2025-06-01', '2025-06-30')).toBe(
      '00123|2025-06-01|2025-06-30',
    );
  });

  it('normalizes internal account-number whitespace without losing leading zeroes', () => {
    expect(createBillUniqueKey('00  123', '2025-06-01', '2025-06-30')).toBe(
      '00 123|2025-06-01|2025-06-30',
    );
  });

  it('rejects an empty account number', () => {
    expect(() => createBillUniqueKey('   ', '2025-06-01', '2025-06-30')).toThrow(
      /account number/u,
    );
  });

  it('removes duplicate rows while preserving first-seen order', () => {
    const first = bill('first');
    const duplicate = { ...first, serviceAddress: 'Duplicate rendering' };
    const second = bill('second', '00456');
    expect(deduplicateBills([first, duplicate, second])).toEqual([first, second]);
  });
});
