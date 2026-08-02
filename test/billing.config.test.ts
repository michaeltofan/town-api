import { describe, expect, it } from 'vitest';
import { loadEnv, STRIPE_API_VERSION } from '../src/config/env.js';

const BASE = {
  DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
  CEREMONY_RATE_LIMIT_HASH_KEY: 'town-ci-ceremony-rate-limit-hash-key-32b',
  STRIPE_BILLING_ENABLED: 'true',
  STRIPE_SECRET_KEY: 'sk_test_town_fake_stripe_secret_placeholder',
  STRIPE_WEBHOOK_SECRET: 'whsec_town_fake_stripe_webhook_secret_placeholder',
  STRIPE_ANNUAL_PRICE_ID: 'price_town_annual_placeholder',
  STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_town_portal_configuration_placeholder',
  STRIPE_CHECKOUT_SUCCESS_URL: 'https://example.test/checkout/success',
  STRIPE_CHECKOUT_CANCEL_URL: 'https://example.test/checkout/cancel',
  STRIPE_PORTAL_RETURN_URL: 'https://example.test/portal/return',
  STRIPE_API_VERSION,
  STRIPE_EXPECTED_LIVEMODE: 'false',
} as const;

describe('loadEnv Stripe billing', () => {
  it('defaults to disabled without Stripe secrets', () => {
    const env = loadEnv({ DATABASE_URL: BASE.DATABASE_URL });
    expect(env.STRIPE_BILLING_ENABLED).toBe(false);
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.STRIPE_WEBHOOK_SECRET).toBeUndefined();
    expect(env.STRIPE_ANNUAL_PRICE_ID).toBeUndefined();
    expect(env.STRIPE_API_VERSION).toBeUndefined();
    expect(env.STRIPE_EXPECTED_LIVEMODE).toBeUndefined();
  });

  it('accepts a valid disabled configuration and does not require Stripe values', () => {
    const env = loadEnv({ DATABASE_URL: BASE.DATABASE_URL, STRIPE_BILLING_ENABLED: 'false' });
    expect(env.STRIPE_BILLING_ENABLED).toBe(false);
  });

  it('accepts a valid enabled configuration', () => {
    const env = loadEnv({ ...BASE });
    expect(env.STRIPE_BILLING_ENABLED).toBe(true);
    expect(env.STRIPE_SECRET_KEY).toBe(BASE.STRIPE_SECRET_KEY);
    expect(env.STRIPE_API_VERSION).toBe(STRIPE_API_VERSION);
    expect(env.STRIPE_EXPECTED_LIVEMODE).toBe(false);
  });

  it('rejects a secret key without the sk_ prefix', () => {
    expect(() =>
      loadEnv({ ...BASE, STRIPE_SECRET_KEY: 'not_a_stripe_secret_long_enough' }),
    ).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('rejects a webhook secret without the whsec_ prefix', () => {
    expect(() =>
      loadEnv({ ...BASE, STRIPE_WEBHOOK_SECRET: 'sk_wrong_type_placeholder_20c' }),
    ).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it('rejects a price id without the price_ prefix', () => {
    expect(() => loadEnv({ ...BASE, STRIPE_ANNUAL_PRICE_ID: 'prod_wrong' })).toThrow(
      /STRIPE_ANNUAL_PRICE_ID/,
    );
  });

  it('rejects a portal configuration id without the bpc_ prefix', () => {
    expect(() => loadEnv({ ...BASE, STRIPE_PORTAL_CONFIGURATION_ID: 'cfg_wrong' })).toThrow(
      /STRIPE_PORTAL_CONFIGURATION_ID/,
    );
  });

  it('rejects a non-https success URL', () => {
    expect(() =>
      loadEnv({ ...BASE, STRIPE_CHECKOUT_SUCCESS_URL: 'http://example.test/x' }),
    ).toThrow(/STRIPE_CHECKOUT_SUCCESS_URL/);
  });

  it('rejects wildcard URLs', () => {
    expect(() =>
      loadEnv({ ...BASE, STRIPE_CHECKOUT_SUCCESS_URL: 'https://*.example.test/x' }),
    ).toThrow(/STRIPE_CHECKOUT_SUCCESS_URL/);
  });

  it('rejects an unsupported api version', () => {
    expect(() => loadEnv({ ...BASE, STRIPE_API_VERSION: '2024-04-10' })).toThrow(
      /STRIPE_API_VERSION/,
    );
  });

  it('requires STRIPE_EXPECTED_LIVEMODE=false outside production', () => {
    expect(() => loadEnv({ ...BASE, STRIPE_EXPECTED_LIVEMODE: 'true' })).toThrow(
      /STRIPE_EXPECTED_LIVEMODE/,
    );
  });

  it('requires STRIPE_EXPECTED_LIVEMODE=true in production', () => {
    expect(() =>
      loadEnv({
        ...BASE,
        NODE_ENV: 'production',
        APP_ENV: 'production',
        APP_COMMIT_SHA: '1234567890abcdef1234567890abcdef12345678',
        DATABASE_URL: 'postgres://town:secret@db.example.com:5432/town',
        STRIPE_CHECKOUT_SUCCESS_URL: 'https://checkout.town.example/success',
        STRIPE_CHECKOUT_CANCEL_URL: 'https://checkout.town.example/cancel',
        STRIPE_PORTAL_RETURN_URL: 'https://checkout.town.example/portal',
        STRIPE_EXPECTED_LIVEMODE: 'false',
      }),
    ).toThrow(/STRIPE_EXPECTED_LIVEMODE/);
  });

  it('does not force live Stripe mode when NODE_ENV=production but APP_ENV=staging', () => {
    const env = loadEnv({
      ...BASE,
      NODE_ENV: 'production',
      APP_ENV: 'staging',
      APP_COMMIT_SHA: '1234567890abcdef1234567890abcdef12345678',
      DATABASE_URL: 'postgres://town:secret@db.example.com:5432/town',
      STRIPE_CHECKOUT_SUCCESS_URL: 'https://checkout.town.example/success',
      STRIPE_CHECKOUT_CANCEL_URL: 'https://checkout.town.example/cancel',
      STRIPE_PORTAL_RETURN_URL: 'https://checkout.town.example/portal',
      STRIPE_EXPECTED_LIVEMODE: 'false',
    });
    expect(env.APP_ENV).toBe('staging');
    expect(env.STRIPE_EXPECTED_LIVEMODE).toBe(false);
  });

  it('requires CEREMONY_RATE_LIMIT_HASH_KEY when billing is enabled', () => {
    const { CEREMONY_RATE_LIMIT_HASH_KEY, ...withoutRateKey } = BASE;
    void CEREMONY_RATE_LIMIT_HASH_KEY;
    expect(() => loadEnv({ ...withoutRateKey })).toThrow(/CEREMONY_RATE_LIMIT_HASH_KEY/);
  });

  it('sanitizes errors and does not leak the STRIPE_SECRET_KEY value', () => {
    const secret = 'malformed_but_extremely_sensitive_local_placeholder_do_not_leak';
    try {
      loadEnv({ ...BASE, STRIPE_SECRET_KEY: secret });
      throw new Error('expected loadEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('STRIPE_SECRET_KEY');
      expect(message).not.toContain(secret);
    }
  });
});
