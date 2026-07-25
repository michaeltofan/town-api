import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'play-api@example.iam.gserviceaccount.com',
  private_key:
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC0REPLACE\n-----END PRIVATE KEY-----\n',
});

const BASE = {
  DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
  GOOGLE_PLAY_BILLING_ENABLED: 'true',
  GOOGLE_PLAY_PACKAGE_NAME: 'com.town.town_safe_space_mobile',
  GOOGLE_PLAY_SUBSCRIPTION_ID: 'town_annual_membership',
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON,
} as const;

describe('loadEnv Google Play billing', () => {
  it('defaults to disabled without Google Play secrets', () => {
    const env = loadEnv({ DATABASE_URL: BASE.DATABASE_URL });
    expect(env.GOOGLE_PLAY_BILLING_ENABLED).toBe(false);
    expect(env.GOOGLE_PLAY_PACKAGE_NAME).toBeUndefined();
    expect(env.GOOGLE_PLAY_SUBSCRIPTION_ID).toBeUndefined();
    expect(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON).toBeUndefined();
  });

  it('accepts a valid disabled configuration and does not require Google Play values', () => {
    const env = loadEnv({
      DATABASE_URL: BASE.DATABASE_URL,
      GOOGLE_PLAY_BILLING_ENABLED: 'false',
    });
    expect(env.GOOGLE_PLAY_BILLING_ENABLED).toBe(false);
  });

  it('accepts a valid enabled configuration', () => {
    const env = loadEnv({ ...BASE });
    expect(env.GOOGLE_PLAY_BILLING_ENABLED).toBe(true);
    expect(env.GOOGLE_PLAY_PACKAGE_NAME).toBe(BASE.GOOGLE_PLAY_PACKAGE_NAME);
    expect(env.GOOGLE_PLAY_SUBSCRIPTION_ID).toBe(BASE.GOOGLE_PLAY_SUBSCRIPTION_ID);
    expect(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON).toBe(SERVICE_ACCOUNT_JSON);
  });

  it('rejects an enabled configuration without package name', () => {
    const { GOOGLE_PLAY_PACKAGE_NAME, ...without } = BASE;
    void GOOGLE_PLAY_PACKAGE_NAME;
    expect(() => loadEnv({ ...without })).toThrow(/GOOGLE_PLAY_PACKAGE_NAME/);
  });

  it('rejects a package name without a dot', () => {
    expect(() => loadEnv({ ...BASE, GOOGLE_PLAY_PACKAGE_NAME: 'townmobile' })).toThrow(
      /GOOGLE_PLAY_PACKAGE_NAME/,
    );
  });

  it('rejects an enabled configuration without subscription id', () => {
    const { GOOGLE_PLAY_SUBSCRIPTION_ID, ...without } = BASE;
    void GOOGLE_PLAY_SUBSCRIPTION_ID;
    expect(() => loadEnv({ ...without })).toThrow(/GOOGLE_PLAY_SUBSCRIPTION_ID/);
  });

  it('rejects invalid service account JSON', () => {
    expect(() =>
      loadEnv({ ...BASE, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '{not-json-but-long-enough-xxxxxx}' }),
    ).toThrow(/GOOGLE_PLAY_SERVICE_ACCOUNT_JSON/);
  });

  it('rejects service account JSON missing private_key and does not leak the secret', () => {
    const secret = JSON.stringify({
      type: 'service_account',
      client_email: 'play-api@example.iam.gserviceaccount.com',
      private_key_id: 'sensitive-key-id-must-not-leak-1234567890',
    });
    try {
      loadEnv({ ...BASE, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: secret });
      throw new Error('expected loadEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
      expect(message).not.toContain('sensitive-key-id-must-not-leak-1234567890');
    }
  });
});
