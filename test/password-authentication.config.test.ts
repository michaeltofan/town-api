import { describe, expect, it } from 'vitest';
import { requireSessionRuntimeConfig } from '../src/ceremony/passkey-authentication/config.js';
import { requirePasswordSignInConfig } from '../src/ceremony/password-authentication/config.js';
import { loadEnv } from '../src/config/env.js';

const DATABASE_URL = 'postgres://town:town@127.0.0.1:5432/town';
const SESSION_KEY = 'town-ci-session-token-hash-key-32bytesxx';
const RATE_KEY = 'town-ci-ceremony-rate-limit-hash-key-32b';
const ORIGIN = 'http://localhost:3000';

describe('password sign-in config', () => {
  it('defaults PASSWORD_SIGN_IN_ENABLED to false', () => {
    const env = loadEnv({ DATABASE_URL });
    expect(env.PASSWORD_SIGN_IN_ENABLED).toBe(false);
  });

  it('requires session token, rate-limit, and allowed-origins keys when enabled', () => {
    const env = loadEnv({
      DATABASE_URL,
      PASSWORD_SIGN_IN_ENABLED: 'true',
      SESSION_TOKEN_HASH_KEY: SESSION_KEY,
      CEREMONY_RATE_LIMIT_HASH_KEY: RATE_KEY,
      WEBAUTHN_ALLOWED_ORIGINS: ORIGIN,
    });
    const config = requirePasswordSignInConfig(env);
    expect(config.sessionTokenHashKey).toBe(SESSION_KEY);
    expect(config.rateLimitHashKey).toBe(RATE_KEY);
    expect(config.webSessionCookieName).toBe('__Host-Http-town_session');

    const session = requireSessionRuntimeConfig(env);
    expect(session.sessionTokenHashKey).toBe(SESSION_KEY);
    expect(session.allowedOrigins).toEqual([ORIGIN]);
  });

  it('does not require PASSKEY_AUTHENTICATION_ENABLED or PASSWORD_AUTH_ENABLED', () => {
    const env = loadEnv({
      DATABASE_URL,
      PASSWORD_SIGN_IN_ENABLED: 'true',
      PASSWORD_AUTH_ENABLED: 'false',
      PASSKEY_AUTHENTICATION_ENABLED: 'false',
      SESSION_TOKEN_HASH_KEY: SESSION_KEY,
      CEREMONY_RATE_LIMIT_HASH_KEY: RATE_KEY,
      WEBAUTHN_ALLOWED_ORIGINS: ORIGIN,
    });
    expect(() => requirePasswordSignInConfig(env)).not.toThrow();
    expect(() => requireSessionRuntimeConfig(env)).not.toThrow();
  });

  it('throws when password sign-in is disabled', () => {
    const env = loadEnv({ DATABASE_URL, PASSWORD_SIGN_IN_ENABLED: 'false' });
    expect(() => requirePasswordSignInConfig(env)).toThrow(/not enabled/);
    expect(() => requireSessionRuntimeConfig(env)).toThrow(/not enabled/);
  });
});
