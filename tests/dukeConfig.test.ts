import { describe, expect, it } from 'vitest';

import {
  DUKE_DEFAULT_BUSINESS_BILLS_URL,
  DUKE_DEFAULT_HOME_URL,
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
      homeUrl: DUKE_DEFAULT_HOME_URL,
      loginUrl: DUKE_DEFAULT_LOGIN_URL,
      businessBillsUrl: DUKE_DEFAULT_BUSINESS_BILLS_URL,
      postNavigationWaitMs: 10_000,
      maximumTablePages: 500,
    });
    expect(
      getDukeConfig({
        DUKE_HOME_URL: 'https://verified.duke.invalid/home',
        DUKE_LOGIN_URL: 'https://verified.duke.invalid/login',
        DUKE_BUSINESS_BILLS_URL: 'https://verified.duke.invalid/billinghistory',
      }),
    ).toMatchObject({
      homeUrl: 'https://verified.duke.invalid/home',
      loginUrl: 'https://verified.duke.invalid/login',
      businessBillsUrl: 'https://verified.duke.invalid/billinghistory',
    });
  });
});
