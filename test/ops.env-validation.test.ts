import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const PROD_DATABASE_URL = 'postgres://town-prod:prod-secret@db.internal:5432/town';
const STG_DATABASE_URL = 'postgres://town-stg:stg-secret@db.internal:5432/town';
const COMMIT_SHA = '1234567890abcdef1234567890abcdef12345678';
const RATE_KEY = 'production-ceremony-rate-limit-hash-key-not-placeholder';

const STRIPE_BASE = {
  STRIPE_BILLING_ENABLED: 'true',
  STRIPE_SECRET_KEY: 'sk_test_town_fake_stripe_secret_placeholder',
  STRIPE_WEBHOOK_SECRET: 'whsec_town_fake_stripe_webhook_secret_placeholder',
  STRIPE_ANNUAL_PRICE_ID: 'price_town_annual_placeholder',
  STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_town_portal_configuration_placeholder',
  STRIPE_CHECKOUT_SUCCESS_URL: 'https://checkout.example/success',
  STRIPE_CHECKOUT_CANCEL_URL: 'https://checkout.example/cancel',
  STRIPE_PORTAL_RETURN_URL: 'https://checkout.example/portal',
  CEREMONY_RATE_LIMIT_HASH_KEY: RATE_KEY,
} as const;

describe('deployment env fail-closed guards', () => {
  describe('production', () => {
    it('accepts a minimal valid production configuration', () => {
      const env = loadEnv({
        NODE_ENV: 'production',
        APP_ENV: 'production',
        APP_COMMIT_SHA: COMMIT_SHA,
        DATABASE_URL: PROD_DATABASE_URL,
      });
      expect(env.APP_ENV).toBe('production');
      expect(env.APP_COMMIT_SHA).toBe(COMMIT_SHA);
    });

    it('rejects missing APP_COMMIT_SHA', () => {
      expect(() =>
        loadEnv({
          APP_ENV: 'production',
          DATABASE_URL: PROD_DATABASE_URL,
        }),
      ).toThrow(/APP_COMMIT_SHA is required/);
    });

    it('rejects APP_COMMIT_SHA with whitespace', () => {
      expect(() =>
        loadEnv({
          APP_ENV: 'production',
          APP_COMMIT_SHA: 'has space',
          DATABASE_URL: PROD_DATABASE_URL,
        }),
      ).toThrow(/APP_COMMIT_SHA/);
    });

    it('rejects localhost DATABASE_URL', () => {
      expect(() =>
        loadEnv({
          APP_ENV: 'production',
          APP_COMMIT_SHA: COMMIT_SHA,
          DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
        }),
      ).toThrow(/DATABASE_URL/);
    });

    it('rejects town:town@ default credentials in DATABASE_URL', () => {
      expect(() =>
        loadEnv({
          APP_ENV: 'production',
          APP_COMMIT_SHA: COMMIT_SHA,
          DATABASE_URL: 'postgres://town:town@db.internal:5432/town',
        }),
      ).toThrow(/DATABASE_URL/);
    });

    it('rejects known CI hash-key placeholders', () => {
      expect(() =>
        loadEnv({
          APP_ENV: 'production',
          APP_COMMIT_SHA: COMMIT_SHA,
          DATABASE_URL: PROD_DATABASE_URL,
          PASSKEY_AUTHENTICATION_ENABLED: 'true',
          WEBAUTHN_RP_ID: 'towncivic.org',
          WEBAUTHN_ALLOWED_ORIGINS: 'https://towncivic.org',
          PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY:
            'production-passkey-auth-challenge-hash-key-not-a-placeholder',
          SESSION_TOKEN_HASH_KEY: 'town-ci-session-token-hash-key-32bytesxx',
          CEREMONY_RATE_LIMIT_HASH_KEY: RATE_KEY,
        }),
      ).toThrow(/SESSION_TOKEN_HASH_KEY.*CI placeholder/);
    });
  });

  describe('staging', () => {
    it('accepts a minimal valid staging configuration', () => {
      const env = loadEnv({
        APP_ENV: 'staging',
        APP_COMMIT_SHA: COMMIT_SHA,
        DATABASE_URL: STG_DATABASE_URL,
      });
      expect(env.APP_ENV).toBe('staging');
    });

    it('rejects missing APP_COMMIT_SHA in staging', () => {
      expect(() =>
        loadEnv({
          APP_ENV: 'staging',
          DATABASE_URL: STG_DATABASE_URL,
        }),
      ).toThrow(/APP_COMMIT_SHA is required/);
    });

    it('rejects STRIPE_EXPECTED_LIVEMODE=true in staging', () => {
      expect(() =>
        loadEnv({
          APP_ENV: 'staging',
          APP_COMMIT_SHA: COMMIT_SHA,
          DATABASE_URL: STG_DATABASE_URL,
          ...STRIPE_BASE,
          STRIPE_EXPECTED_LIVEMODE: 'true',
        }),
      ).toThrow(/STRIPE_EXPECTED_LIVEMODE/);
    });

    it('rejects sk_live_ secret keys in staging', () => {
      expect(() =>
        loadEnv({
          APP_ENV: 'staging',
          APP_COMMIT_SHA: COMMIT_SHA,
          DATABASE_URL: STG_DATABASE_URL,
          ...STRIPE_BASE,
          STRIPE_SECRET_KEY: 'sk_live_replace_with_local_stripe_test_key_placeholder',
          STRIPE_EXPECTED_LIVEMODE: 'false',
        }),
      ).toThrow(/STRIPE_SECRET_KEY/);
    });
  });

  describe('APP_ENV resolution', () => {
    it('defaults to development when NODE_ENV is development', () => {
      const env = loadEnv({
        DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
      });
      expect(env.APP_ENV).toBe('development');
    });

    it('defaults to test when NODE_ENV=test', () => {
      const env = loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
      });
      expect(env.APP_ENV).toBe('test');
    });

    it('honors explicit APP_ENV=staging over NODE_ENV=production', () => {
      const env = loadEnv({
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        APP_COMMIT_SHA: COMMIT_SHA,
        DATABASE_URL: STG_DATABASE_URL,
      });
      expect(env.APP_ENV).toBe('staging');
    });

    it('rejects unknown APP_ENV values', () => {
      expect(() =>
        loadEnv({
          APP_ENV: 'preview',
          DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
        }),
      ).toThrow(/APP_ENV must be one of/);
    });
  });

  describe('READINESS_TIMEOUT_MS and GRACEFUL_SHUTDOWN_TIMEOUT_MS defaults', () => {
    it('applies defaults when unset', () => {
      const env = loadEnv({
        DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
      });
      expect(env.READINESS_TIMEOUT_MS).toBe(3000);
      expect(env.GRACEFUL_SHUTDOWN_TIMEOUT_MS).toBe(10000);
    });

    it('honors provided integer values', () => {
      const env = loadEnv({
        DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
        READINESS_TIMEOUT_MS: '2500',
        GRACEFUL_SHUTDOWN_TIMEOUT_MS: '15000',
      });
      expect(env.READINESS_TIMEOUT_MS).toBe(2500);
      expect(env.GRACEFUL_SHUTDOWN_TIMEOUT_MS).toBe(15000);
    });

    it('rejects out-of-range values', () => {
      expect(() =>
        loadEnv({
          DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
          READINESS_TIMEOUT_MS: '99',
        }),
      ).toThrow(/Invalid environment configuration/);
    });
  });
});
