import { describe, expect, it } from 'vitest';
import { requirePasskeyAuthenticationConfig } from '../src/ceremony/passkey-authentication/config.js';
import { loadEnv } from '../src/config/env.js';
import {
  TEST_CEREMONY_RATE_LIMIT_HASH_KEY,
  TEST_ORIGIN,
  TEST_PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY,
  TEST_RP_ID,
  TEST_SESSION_TOKEN_HASH_KEY,
  TEST_WEB_SESSION_COOKIE_NAME,
} from './helpers/passkey-authentication.js';

const DATABASE_URL = 'postgres://town:town@127.0.0.1:5432/town';

function authenticationEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL,
    NODE_ENV: 'test',
    PASSKEY_AUTHENTICATION_ENABLED: 'true',
    WEBAUTHN_RP_ID: TEST_RP_ID,
    WEBAUTHN_ALLOWED_ORIGINS: TEST_ORIGIN,
    PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY: TEST_PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY,
    SESSION_TOKEN_HASH_KEY: TEST_SESSION_TOKEN_HASH_KEY,
    CEREMONY_RATE_LIMIT_HASH_KEY: TEST_CEREMONY_RATE_LIMIT_HASH_KEY,
    ...overrides,
  };
}

describe('passkey authentication environment config', () => {
  it('defaults the feature disabled', () => {
    const env = loadEnv({ DATABASE_URL });

    expect(env.PASSKEY_AUTHENTICATION_ENABLED).toBe(false);
    expect(env.PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY).toBeUndefined();
    expect(env.SESSION_TOKEN_HASH_KEY).toBeUndefined();
    expect(env.WEB_SESSION_COOKIE_NAME).toBeUndefined();
  });

  it('requires RP ID, origins, challenge key, session key, and rate limit key when enabled', () => {
    const required = [
      ['WEBAUTHN_RP_ID', /WEBAUTHN_RP_ID is required/],
      ['WEBAUTHN_ALLOWED_ORIGINS', /WEBAUTHN_ALLOWED_ORIGINS is required/],
      [
        'PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY',
        /PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY is required/,
      ],
      ['SESSION_TOKEN_HASH_KEY', /SESSION_TOKEN_HASH_KEY is required/],
      ['CEREMONY_RATE_LIMIT_HASH_KEY', /CEREMONY_RATE_LIMIT_HASH_KEY is required/],
    ] as const;

    for (const [key, message] of required) {
      const env = authenticationEnv();
      const { [key]: _omitted, ...missing } = env;
      expect(() => loadEnv(missing), key).toThrow(message);
    }
  });

  it('loads the runtime config with the default web cookie name', () => {
    const env = loadEnv(authenticationEnv());
    const config = requirePasskeyAuthenticationConfig(env);

    expect(config.enabled).toBe(true);
    expect(config.rpId).toBe(TEST_RP_ID);
    expect(config.allowedOrigins).toEqual([TEST_ORIGIN]);
    expect(config.webSessionCookieName).toBe(TEST_WEB_SESSION_COOKIE_NAME);
  });

  it('accepts an explicit web cookie name', () => {
    const env = loadEnv(authenticationEnv({ WEB_SESSION_COOKIE_NAME: '__Host-town_alt_session' }));
    const config = requirePasskeyAuthenticationConfig(env);

    expect(config.webSessionCookieName).toBe('__Host-town_alt_session');
  });

  it('rejects localhost production configuration', () => {
    expect(() =>
      loadEnv(
        authenticationEnv({
          NODE_ENV: 'production',
          WEBAUTHN_RP_ID: 'localhost',
          WEBAUTHN_ALLOWED_ORIGINS: 'http://localhost:3000',
        }),
      ),
    ).toThrow(/localhost/);
  });
});
