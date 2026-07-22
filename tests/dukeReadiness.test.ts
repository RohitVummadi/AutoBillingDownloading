import { describe, expect, it } from 'vitest';

import { dukeEmptyStateMessage, isRealDukeBillRow } from '../src/portals/duke/readiness.js';

describe('Duke billing-table readiness', () => {
  it('does not treat a one-row loading placeholder as a real bill row', () => {
    expect(isRealDukeBillRow('', 'Loading...', '')).toBe(false);
    expect(isRealDukeBillRow('Loading', 'Loading...', 'Loading...')).toBe(false);
  });

  it('accepts a complete live bill row', () => {
    expect(
      isRealDukeBillRow(
        '910029795124',
        'CLEMSON UNIVERSITY 150 DISCOVERY LN CLEMSON SC 29631',
        'June 06, 2026 - July 08, 2026',
      ),
    ).toBe(true);
  });

  it('recognizes an explicit empty-state result', () => {
    expect(dukeEmptyStateMessage('No billing activity is available for this account.')).toBe(
      'No billing activity',
    );
  });
});
