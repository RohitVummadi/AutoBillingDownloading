import { describe, expect, it } from 'vitest';

import {
  areDukeBillingCycleStartsNonIncreasing,
  canUseDukeDescendingEarlyStop,
  classifyDukeBillForDiscovery,
  classifyDukeBillingCycleStart,
  createDukeBillRowsFingerprint,
  detectDukeSortDirection,
  hasDukePaginationAdvanced,
  isDukePaginationControlEnabled,
  parseDukePaginationMetadata,
  shouldClickForDescendingBillingCycleSort,
} from '../src/portals/duke/pagination.js';
import { dukeEmptyStateMessage, isRealDukeBillRow } from '../src/portals/duke/readiness.js';

const enabledControl = {
  exists: true,
  visible: true,
  enabled: true,
  disabledAttribute: null,
  ariaDisabled: null,
  className: 'page-link',
  ancestorClassName: 'pagination',
};

describe('Duke billing-history pagination guards', () => {
  it('recognizes five real pages and stops when Next is disabled', () => {
    const seen = new Set<string>();
    for (let page = 1; page <= 5; page += 1) {
      const fingerprint = createDukeBillRowsFingerprint([`91000000000${page}|2026-06-0${page}|2026-07-0${page}`], null);
      expect(seen.has(fingerprint)).toBe(false);
      seen.add(fingerprint);
      expect(parseDukePaginationMetadata(`Page ${page} of 5`)).toEqual({
        currentPage: page,
        totalPages: 5,
        rangeStart: null,
        rangeEnd: null,
        totalResults: null,
      });
    }
    expect(isDukePaginationControlEnabled({ ...enabledControl, enabled: false })).toBe(false);
    expect(seen).toHaveLength(5);
  });

  it('uses real bill-row fingerprints when page metadata is unavailable', () => {
    expect(parseDukePaginationMetadata('')).toEqual({
      currentPage: null,
      totalPages: null,
      rangeStart: null,
      rangeEnd: null,
      totalResults: null,
    });
    const pageOne = createDukeBillRowsFingerprint(['910029795124|2026-06-06|2026-07-08'], null);
    const pageTwo = createDukeBillRowsFingerprint(['910029795125|2026-06-10|2026-07-10'], null);
    expect(pageTwo).not.toBe(pageOne);
  });

  it('detects a Next click that leaves the bill-row fingerprint unchanged', () => {
    const before = createDukeBillRowsFingerprint(['910029795124|2026-06-06|2026-07-08'], null);
    const after = createDukeBillRowsFingerprint(['910029795124|2026-06-06|2026-07-08'], null);
    expect(after).toBe(before);
  });

  it('detects a repeated page fingerprint', () => {
    const seen = new Set<string>();
    const fingerprint = createDukeBillRowsFingerprint(['910029795124|2026-06-06|2026-07-08'], null);
    seen.add(fingerprint);
    expect(seen.has(fingerprint)).toBe(true);
  });

  it('does not count a placeholder row as a real bill row', () => {
    expect(isRealDukeBillRow('Loading…', 'Loading…', 'Loading…')).toBe(false);
  });

  it('recognizes a confirmed empty table', () => {
    const empty = dukeEmptyStateMessage('No records are available for this account.');
    expect(empty).toBe('No records');
    expect(createDukeBillRowsFingerprint([], empty)).toContain('No records');
  });

  it('does not click a Next control disabled with aria-disabled', () => {
    expect(
      isDukePaginationControlEnabled({ ...enabledControl, ariaDisabled: 'true' }),
    ).toBe(false);
  });

  it('parses Duke result ranges into calculated current and total pages', () => {
    expect(parseDukePaginationMetadata('41-50 of 2000')).toEqual({
      currentPage: 5,
      totalPages: 200,
      rangeStart: 41,
      rangeEnd: 50,
      totalResults: 2000,
    });
  });

  it('requests a Billing Cycle click when another column is sorted, then confirms descending', () => {
    const dueDateSort = detectDukeSortDirection({
      ariaSort: null,
      dataSort: 'due-date',
      dataSortDirection: null,
      className: 'sortable active',
      iconSignals: [],
    });
    const billingCycleDescending = detectDukeSortDirection({
      ariaSort: 'descending',
      dataSort: 'billing-cycle',
      dataSortDirection: 'desc',
      className: 'sortable sort-desc',
      iconSignals: ['blue down arrow'],
    });
    expect(dueDateSort).toBe('unknown');
    expect(shouldClickForDescendingBillingCycleSort(dueDateSort)).toBe(true);
    expect(billingCycleDescending).toBe('descending');
  });

  it('does not click Billing Cycle when its header is already descending', () => {
    const direction = detectDukeSortDirection({
      ariaSort: 'descending',
      dataSort: null,
      dataSortDirection: null,
      className: 'column-header',
      iconSignals: [],
    });
    expect(direction).toBe('descending');
    expect(shouldClickForDescendingBillingCycleSort(direction)).toBe(false);
  });

  it('verifies non-increasing Billing Cycle starts before allowing an early stop', () => {
    expect(
      areDukeBillingCycleStartsNonIncreasing([
        new Date(Date.UTC(2026, 5, 10)),
        new Date(Date.UTC(2026, 5, 6)),
        new Date(Date.UTC(2026, 5, 1)),
        new Date(Date.UTC(2026, 4, 29)),
      ]),
    ).toBe(true);
    expect(
      areDukeBillingCycleStartsNonIncreasing([
        new Date(Date.UTC(2026, 5, 1)),
        new Date(Date.UTC(2026, 5, 4)),
      ]),
    ).toBe(false);
    expect(
      canUseDukeDescendingEarlyStop('unknown', [new Date(Date.UTC(2026, 5, 4))]),
    ).toBe(false);
  });

  it('applies the inclusive start-date rule without considering Billing Cycle end or View Bill availability', () => {
    const start = new Date(Date.UTC(2026, 5, 1));
    const end = new Date(Date.UTC(2026, 6, 12));
    expect(classifyDukeBillingCycleStart(new Date(Date.UTC(2026, 6, 13)), start, end)).toBe(
      'skip-newer',
    );
    // A matching row remains eligible even if its View Bill action is absent;
    // discovery logs it and continues rather than treating it as a boundary.
    expect(classifyDukeBillingCycleStart(new Date(Date.UTC(2026, 5, 1)), start, end)).toBe(
      'include',
    );
    expect(
      classifyDukeBillForDiscovery(new Date(Date.UTC(2026, 5, 1)), start, end, false),
    ).toBe('include-unavailable');
    expect(classifyDukeBillingCycleStart(new Date(Date.UTC(2026, 4, 29)), start, end)).toBe(
      'stop-before-start',
    );
  });

  it('requires both a changed range and a changed row fingerprint after Next', () => {
    const before = { paginationRange: '1-10 of 2000', fingerprint: 'page-one' };
    expect(
      hasDukePaginationAdvanced(before, {
        paginationRange: '11-20 of 2000',
        fingerprint: 'page-two',
      }),
    ).toEqual({ rangeChanged: true, fingerprintChanged: true });
    expect(
      hasDukePaginationAdvanced(before, {
        paginationRange: '1-10 of 2000',
        fingerprint: 'page-two',
      }),
    ).toEqual({ rangeChanged: false, fingerprintChanged: true });
    expect(
      hasDukePaginationAdvanced(before, {
        paginationRange: '11-20 of 2000',
        fingerprint: 'page-one',
      }),
    ).toEqual({ rangeChanged: true, fingerprintChanged: false });
  });
});
