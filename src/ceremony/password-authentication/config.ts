import type { Env } from '../../config/env.js';
import {
  DEFAULT_WEB_SESSION_COOKIE_NAME,
  SESSION_TOKEN_HASH_KEY_MIN_LENGTH,
} from '../passkey-authentication/policy.js';

export type PasswordSignInConfig = {
  enabled: true;
  sessionTokenHashKey: string;
  rateLimitHashKey: string;
  webSessionCookieName: string;
};

/**
 * Resolve password sign-in runtime config. Call only when PASSWORD_SIGN_IN_ENABLED is true.
 * Independent of PASSWORD_AUTH_ENABLED and PASSKEY_AUTHENTICATION_ENABLED.
 * Does not require or apply PASSWORD_HASH_PEPPER — pepper remains reserved/unimplemented.
 */
export function requirePasswordSignInConfig(env: Env): PasswordSignInConfig {
  if (!env.PASSWORD_SIGN_IN_ENABLED) {
    throw new Error('Password sign-in is not enabled');
  }

  const sessionTokenHashKey = env.SESSION_TOKEN_HASH_KEY;
  const rateLimitHashKey = env.CEREMONY_RATE_LIMIT_HASH_KEY;
  const webSessionCookieName = env.WEB_SESSION_COOKIE_NAME ?? DEFAULT_WEB_SESSION_COOKIE_NAME;

  if (!sessionTokenHashKey || !rateLimitHashKey) {
    throw new Error('Password sign-in secrets are not configured');
  }
  if (sessionTokenHashKey.length < SESSION_TOKEN_HASH_KEY_MIN_LENGTH) {
    throw new Error('Session token hash key does not meet minimum length');
  }

  return {
    enabled: true,
    sessionTokenHashKey,
    rateLimitHashKey,
    webSessionCookieName,
  };
}
