import { describe, expect, it } from 'vitest';

import {
  compareCalendarDates,
  dateRangesOverlap,
  formatCalendarDate,
  parseBillingCycle,
  parseIsoDate,
} from '../src/utils/dates.js';

describe('billing-cycle dates', () => {
  it('parses MM/DD/YYYY ranges into canonical calendar dates', () => {
    const cycle = parseBillingCycle('06/06/2025 - 07/08/2025');
    expect(cycle.startIso).toBe('2025-06-06');
    expect(cycle.endIso).toBe('2025-07-08');
  });

  it('accepts a Unicode dash and flexible whitespace', () => {
    const cycle = parseBillingCycle(' 6/6/2025  –  7/8/2025 ');
    expect([cycle.startIso, cycle.endIso]).toEqual(['2025-06-06', '2025-07-08']);
  });

  it.each([
    'not a cycle',
    '02/30/2025 - 03/01/2025',
    '06/10/2025 - 06/01/2025',
    '2025-06-01 - 2025-06-30',
  ])('rejects invalid billing cycle %s', (value) => {
    expect(() => parseBillingCycle(value)).toThrow(/Invalid|Expected/u);
  });

  it('handles leap days strictly', () => {
    expect(parseBillingCycle('02/29/2024 - 03/01/2024').startIso).toBe('2024-02-29');
    expect(() => parseBillingCycle('02/29/2025 - 03/01/2025')).toThrow(/not a real/u);
  });
});

describe('calendar comparisons', () => {
  it('uses inclusive overlap boundaries', () => {
    expect(
      dateRangesOverlap(
        parseIsoDate('2025-05-01'),
        parseIsoDate('2025-06-01'),
        parseIsoDate('2025-06-01'),
        parseIsoDate('2025-06-30'),
      ),
    ).toBe(true);
    expect(
      dateRangesOverlap(
        parseIsoDate('2025-04-01'),
        parseIsoDate('2025-05-31'),
        parseIsoDate('2025-06-01'),
        parseIsoDate('2025-06-30'),
      ),
    ).toBe(false);
  });

  it('does not shift a calendar date through the local timezone', () => {
    const date = parseIsoDate('2025-01-01');
    expect(date.getTime()).toBe(Date.UTC(2025, 0, 1));
    expect(formatCalendarDate(date)).toBe('2025-01-01');
    expect(compareCalendarDates(date, new Date(Date.UTC(2025, 0, 1, 23, 59)))).toBe(0);
  });

  it('rejects invalid ISO calendar dates', () => {
    expect(() => parseIsoDate('2025-02-29')).toThrow(/not a real/u);
    expect(() => parseIsoDate('06/01/2025')).toThrow(/YYYY-MM-DD/u);
  });
});
