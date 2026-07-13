import { describe, expect, it } from 'vitest';

import { mapDukeColumns, normalizeHeaderText } from '../src/portals/duke/tableColumns.js';

describe('Duke table header mapping', () => {
  it('maps required and optional fields without relying on fixed order', () => {
    expect(
      mapDukeColumns([
        'Select',
        'Amount Due',
        'Service Address',
        'Billing Cycle',
        'Account #',
        'Due Date',
      ]),
    ).toEqual({
      selection: 0,
      amountDue: 1,
      serviceAddress: 2,
      billingCycle: 3,
      accountNumber: 4,
      dueDate: 5,
    });
  });

  it('normalizes whitespace and punctuation', () => {
    expect(normalizeHeaderText('  ACCOUNT\u00a0NUMBER: ')).toBe('account number');
  });

  it('reports missing required columns', () => {
    expect(() => mapDukeColumns(['Account Number', 'Amount Due'])).toThrow(
      /Service address.*Billing cycle/u,
    );
  });
});
