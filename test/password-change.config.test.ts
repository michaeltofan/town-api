import { describe, expect, it } from 'vitest';
import { requirePasswordChangeConfig } from '../src/ceremony/password-change/config.js';
import { loadEnv } from '../src/config/env.js';

const DATABASE_URL = 'postgres://town:town@127.0.0.1:5432/town';
const SESSION_KEY = 'town-ci-session-token-hash-key-32bytesxx';
const RATE_KEY = 'town-ci-ceremony-rate-limit-hash-key-32b';
const ORIGIN = 'http://localhost:3000';

describe('password change config', () => {
  it('defaults PASSWORD_CHANGE_ENABLED to false', () => {
    const env = loadEnv({ DATABASE_URL });
    expect(env.PASSWORD_CHANGE_ENABLED).toBe(false);
  });

  it('requires session token, rate-limit, and allowed-origins keys when enabled', () => {
    const env = loadEnv({
      DATABASE_URL,
      PASSWORD_CHANGE_ENABLED: 'true',
      SESSION_TOKEN_HASH_KEY: SESSION_KEY,
      CEREMONY_RATE_LIMIT_HASH_KEY: RATE_KEY,
      WEBAUTHN_ALLOWED_ORIGINS: ORIGIN,
    });
    const config = requirePasswordChangeConfig(env);
    expect(config.sessionTokenHashKey).toBe(SESSION_KEY);
    expect(config.rateLimitHashKey).toBe(RATE_KEY);
    expect(config.webSessionCookieName).toBe('__Host-Http-town_session');
    expect(config.allowedOrigins).toEqual([ORIGIN]);
  });

  it('does not require PASSKEY_AUTHENTICATION_ENABLED, PASSWORD_SIGN_IN_ENABLED, or PASSWORD_AUTH_ENABLED', () => {
    const env = loadEnv({
      DATABASE_URL,
      PASSWORD_CHANGE_ENABLED: 'true',
      PASSWORD_AUTH_ENABLED: 'false',
      PASSWORD_SIGN_IN_ENABLED: 'false',
      PASSKEY_AUTHENTICATION_ENABLED: 'false',
      SESSION_TOKEN_HASH_KEY: SESSION_KEY,
      CEREMONY_RATE_LIMIT_HASH_KEY: RATE_KEY,
      WEBAUTHN_ALLOWED_ORIGINS: ORIGIN,
    });
    expect(() => requirePasswordChangeConfig(env)).not.toThrow();
  });

  it('throws when password change is disabled', () => {
    const env = loadEnv({ DATABASE_URL, PASSWORD_CHANGE_ENABLED: 'false' });
    expect(() => requirePasswordChangeConfig(env)).toThrow(/not enabled/);
  });
});
