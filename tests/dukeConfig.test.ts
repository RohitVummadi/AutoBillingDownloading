import { describe, expect, it } from 'vitest';

import {
  DUKE_DEFAULT_BILLS_URL,
  DUKE_DEFAULT_LOGIN_URL,
  getDukeConfig,
  getDukeCredentials,
} from '../src/portals/duke/config.js';

describe('Duke environment configuration', () => {
  it('fails clearly when either credential is missing', () => {
    expect(() => getDukeCredentials({})).toThrow(/DUKE_USERNAME.*DUKE_PASSWORD/u);
    expect(() => getDukeCredentials({ DUKE_USERNAME: 'user' })).toThrow(/DUKE_PASSWORD/u);
    expect(() => getDukeCredentials({ DUKE_PASSWORD: 'password' })).toThrow(/DUKE_USERNAME/u);
  });

  it('returns credentials without exposing or transforming the password', () => {
    expect(
      getDukeCredentials({ DUKE_USERNAME: ' duke-user ', DUKE_PASSWORD: ' password with spaces ' }),
    ).toEqual({ username: 'duke-user', password: ' password with spaces ' });
  });

  it('uses marked defaults and supports live-site URL overrides', () => {
    expect(getDukeConfig({})).toMatchObject({
      loginUrl: DUKE_DEFAULT_LOGIN_URL,
      billsUrl: DUKE_DEFAULT_BILLS_URL,
    });
    expect(
      getDukeConfig({
        DUKE_LOGIN_URL: 'https://verified.duke.invalid/login',
        DUKE_BILLS_URL: 'https://verified.duke.invalid/bills',
      }),
    ).toMatchObject({
      loginUrl: 'https://verified.duke.invalid/login',
      billsUrl: 'https://verified.duke.invalid/bills',
    });
  });
});
