// DEPRECATED: The Duke adapter no longer uses a bulk "Print Bills" preflight.
// Bills are downloaded per-row via the "View Bill" link. This test is reduced
// to a sanity check on the active selector and no longer exercises the removed
// assertDukeBulkPrintPreflight path.
import { describe, expect, it } from 'vitest';

import { dukeSelectors } from '../src/portals/duke/selectors.js';

describe('Duke bill PDF link selector', () => {
  it('identifies the per-row View Bill action', () => {
    expect(dukeSelectors.billPdfLink).toMatch(/view bill/iu);
  });
});
