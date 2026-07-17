import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const DATABASE_URL = 'postgres://town:town@127.0.0.1:5432/town';
const RECOVERY_HASH_KEY = 'town-ci-account-recovery-hash-key-32byt';
const RECOVERY_TOKEN_HASH_KEY = 'town-ci-account-recovery-token-key-32b';
const RATE_LIMIT_HASH_KEY = 'town-ci-ceremony-rate-limit-hash-key-32b';
const CHALLENGE_HASH_KEY = 'town-ci-webauthn-challenge-hash-key-32by';

function recoveryEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL,
    NODE_ENV: 'test',
    ACCOUNT_RECOVERY_ENABLED: 'true',
    ACCOUNT_RECOVERY_HASH_KEY: RECOVERY_HASH_KEY,
    ACCOUNT_RECOVERY_TOKEN_HASH_KEY: RECOVERY_TOKEN_HASH_KEY,
    ACCOUNT_RECOVERY_DELIVERY_MODE: 'test',
    CEREMONY_RATE_LIMIT_HASH_KEY: RATE_LIMIT_HASH_KEY,
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_ALLOWED_ORIGINS: 'http://localhost:3000',
    WEBAUTHN_CHALLENGE_HASH_KEY: CHALLENGE_HASH_KEY,
    ...overrides,
  };
}

describe('Account recovery environment config', () => {
  it('defaults the feature disabled', () => {
    const env = loadEnv({ DATABASE_URL });

    expect(env.ACCOUNT_RECOVERY_ENABLED).toBe(false);
    expect(env.ACCOUNT_RECOVERY_HASH_KEY).toBeUndefined();
    expect(env.ACCOUNT_RECOVERY_TOKEN_HASH_KEY).toBeUndefined();
  });

  it('requires recovery keys, delivery mode, rate-limit key, and WebAuthn config when enabled', () => {
    const required = [
      ['ACCOUNT_RECOVERY_HASH_KEY', /ACCOUNT_RECOVERY_HASH_KEY is required/],
      ['ACCOUNT_RECOVERY_TOKEN_HASH_KEY', /ACCOUNT_RECOVERY_TOKEN_HASH_KEY is required/],
      [
        'ACCOUNT_RECOVERY_DELIVERY_MODE',
        /ACCOUNT_RECOVERY_DELIVERY_MODE must be test or development/,
      ],
      ['CEREMONY_RATE_LIMIT_HASH_KEY', /CEREMONY_RATE_LIMIT_HASH_KEY is required/],
      ['WEBAUTHN_RP_ID', /WEBAUTHN_RP_ID is required/],
      ['WEBAUTHN_ALLOWED_ORIGINS', /WEBAUTHN_ALLOWED_ORIGINS is required/],
      ['WEBAUTHN_CHALLENGE_HASH_KEY', /WEBAUTHN_CHALLENGE_HASH_KEY is required/],
    ] as const;

    for (const [key, message] of required) {
      const env = recoveryEnv();
      const { [key]: _omitted, ...missing } = env;
      expect(() => loadEnv(missing), key).toThrow(message);
    }
  });

  it('rejects production enablement with test/development delivery', () => {
    expect(() =>
      loadEnv(
        recoveryEnv({
          NODE_ENV: 'production',
          ACCOUNT_RECOVERY_DELIVERY_MODE: 'test',
          WEBAUTHN_RP_ID: 'towncivic.org',
          WEBAUTHN_ALLOWED_ORIGINS: 'https://towncivic.org',
        }),
      ),
    ).toThrow(/cannot be true in production/);
  });

  it('accepts a fully configured test environment', () => {
    const env = loadEnv(recoveryEnv());
    expect(env.ACCOUNT_RECOVERY_ENABLED).toBe(true);
    expect(env.ACCOUNT_RECOVERY_DELIVERY_MODE).toBe('test');
    expect(env.WEBAUTHN_RP_ID).toBe('localhost');
  });
});
