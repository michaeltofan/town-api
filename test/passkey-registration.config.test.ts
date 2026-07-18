import { describe, expect, it } from 'vitest';
import { parseAllowedOrigins } from '../src/ceremony/passkey-registration/config.js';
import { loadEnv } from '../src/config/env.js';

const DATABASE_URL = 'postgres://town:town@127.0.0.1:5432/town';
const EMAIL_HASH_KEY = 'town-ci-email-verification-hash-key-32b';
const RATE_LIMIT_HASH_KEY = 'town-ci-ceremony-rate-limit-hash-key-32b';
const CHALLENGE_HASH_KEY = 'town-ci-webauthn-challenge-hash-key-32by';
const PROD_EMAIL_HASH_KEY = 'production-email-verification-hash-key-not-a-placeholder';
const PROD_RATE_LIMIT_HASH_KEY = 'production-ceremony-rate-limit-hash-key-not-placeholder';
const PROD_CHALLENGE_HASH_KEY = 'production-webauthn-challenge-hash-key-not-a-placeholder';

const PROD_DATABASE_URL = 'postgres://town-prod:prod-secret@db.internal:5432/town';
const PROD_COMMIT_SHA = '1234567890abcdef1234567890abcdef12345678';

function webauthnEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const isProduction = overrides.NODE_ENV === 'production' || overrides.APP_ENV === 'production';
  return {
    DATABASE_URL: isProduction ? PROD_DATABASE_URL : DATABASE_URL,
    NODE_ENV: 'test',
    ...(isProduction ? { APP_COMMIT_SHA: PROD_COMMIT_SHA } : {}),
    WEBAUTHN_REGISTRATION_ENABLED: 'true',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_ALLOWED_ORIGINS: 'http://localhost:3000',
    WEBAUTHN_CHALLENGE_HASH_KEY: isProduction ? PROD_CHALLENGE_HASH_KEY : CHALLENGE_HASH_KEY,
    EMAIL_VERIFICATION_HASH_KEY: isProduction ? PROD_EMAIL_HASH_KEY : EMAIL_HASH_KEY,
    CEREMONY_RATE_LIMIT_HASH_KEY: isProduction ? PROD_RATE_LIMIT_HASH_KEY : RATE_LIMIT_HASH_KEY,
    ...overrides,
  };
}

describe('WebAuthn registration environment config', () => {
  it('defaults the feature disabled', () => {
    const env = loadEnv({ DATABASE_URL });

    expect(env.WEBAUTHN_REGISTRATION_ENABLED).toBe(false);
    expect(env.WEBAUTHN_RP_ID).toBeUndefined();
    expect(env.WEBAUTHN_ALLOWED_ORIGINS).toBeUndefined();
  });

  it('requires RP ID, origins, challenge key, email hash key, and rate limit key when enabled', () => {
    const required = [
      ['WEBAUTHN_RP_ID', /WEBAUTHN_RP_ID is required/],
      ['WEBAUTHN_ALLOWED_ORIGINS', /WEBAUTHN_ALLOWED_ORIGINS is required/],
      ['WEBAUTHN_CHALLENGE_HASH_KEY', /WEBAUTHN_CHALLENGE_HASH_KEY is required/],
      ['EMAIL_VERIFICATION_HASH_KEY', /EMAIL_VERIFICATION_HASH_KEY is required/],
      ['CEREMONY_RATE_LIMIT_HASH_KEY', /CEREMONY_RATE_LIMIT_HASH_KEY is required/],
    ] as const;

    for (const [key, message] of required) {
      const env = webauthnEnv();
      const { [key]: _omitted, ...missing } = env;
      expect(() => loadEnv(missing), key).toThrow(message);
    }
  });

  it('rejects wildcard origins', () => {
    expect(() =>
      parseAllowedOrigins('https://*.towncivic.org', { nodeEnv: 'test', appEnv: 'test' }),
    ).toThrow(/wildcards/);
    expect(() =>
      loadEnv(webauthnEnv({ WEBAUTHN_ALLOWED_ORIGINS: 'https://*.towncivic.org' })),
    ).toThrow(/wildcards/);
  });

  it('rejects localhost production configuration', () => {
    expect(() =>
      loadEnv(
        webauthnEnv({
          NODE_ENV: 'production',
          WEBAUTHN_RP_ID: 'localhost',
          WEBAUTHN_ALLOWED_ORIGINS: 'http://localhost:3000',
        }),
      ),
    ).toThrow(/localhost/);
  });

  it('rejects production railway, www, api, and http origins', () => {
    const origins = [
      'https://town-api.up.railway.app',
      'https://www.towncivic.org',
      'https://api.towncivic.org',
      'http://towncivic.org',
    ];

    for (const origin of origins) {
      expect(() =>
        loadEnv(
          webauthnEnv({
            NODE_ENV: 'production',
            WEBAUTHN_RP_ID: 'towncivic.org',
            WEBAUTHN_ALLOWED_ORIGINS: origin,
          }),
        ),
      ).toThrow(/production|https|temporary|www|API/);
    }
  });

  it('accepts the exact towncivic.org production policy', () => {
    const env = loadEnv(
      webauthnEnv({
        NODE_ENV: 'production',
        WEBAUTHN_RP_ID: 'towncivic.org',
        WEBAUTHN_ALLOWED_ORIGINS: 'https://towncivic.org',
      }),
    );

    expect(env.WEBAUTHN_REGISTRATION_ENABLED).toBe(true);
    expect(env.WEBAUTHN_RP_ID).toBe('towncivic.org');
    expect(env.WEBAUTHN_ALLOWED_ORIGINS).toBe('https://towncivic.org');
  });

  it('defaults WEBAUTHN_RP_NAME to TOWN', () => {
    const env = loadEnv(webauthnEnv({ WEBAUTHN_RP_NAME: undefined }));

    expect(env.WEBAUTHN_RP_NAME).toBe('TOWN');
  });
});
