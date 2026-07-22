import { describe, expect, it } from 'vitest';

import { toDukePortalAccount } from '../src/portals/duke/accounts.js';

describe('Duke Business Partner identities', () => {
  it('uses the numeric identifier from a stable option value', () => {
    expect(
      toDukePortalAccount({
        text: '1102669801 (CLEMSON UNIVERSITY)',
        value: '1102669801',
        isCurrent: true,
      }),
    ).toEqual({
      id: '1102669801',
      label: '1102669801 (CLEMSON UNIVERSITY)',
      isCurrent: true,
    });
  });

  it('rejects a label that does not contain one reliable account number', () => {
    expect(() =>
      toDukePortalAccount({ text: 'Clemson University', isCurrent: false }),
    ).toThrow(/stable numeric account id/u);
    expect(() =>
      toDukePortalAccount({ text: '1102669801 / 1102669802', isCurrent: false }),
    ).toThrow(/exactly one/u);
  });
});
