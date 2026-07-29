import type { Env } from '../../config/env.js';
import { parseAllowedOrigins } from '../passkey-registration/config.js';
import {
  DEFAULT_WEB_SESSION_COOKIE_NAME,
  SESSION_TOKEN_HASH_KEY_MIN_LENGTH,
} from '../passkey-authentication/policy.js';

export type PasswordChangeConfig = {
  enabled: true;
  sessionTokenHashKey: string;
  rateLimitHashKey: string;
  webSessionCookieName: string;
  allowedOrigins: readonly string[];
};

/**
 * Resolve password-change runtime config. Call only when PASSWORD_CHANGE_ENABLED is true.
 * Independent of PASSWORD_AUTH_ENABLED, PASSWORD_SIGN_IN_ENABLED, and PASSKEY_AUTHENTICATION_ENABLED.
 * Requires SESSION_TOKEN_HASH_KEY, CEREMONY_RATE_LIMIT_HASH_KEY, and WEBAUTHN_ALLOWED_ORIGINS
 * (CSRF allow-list shared with session cookie routes).
 */
export function requirePasswordChangeConfig(env: Env): PasswordChangeConfig {
  if (!env.PASSWORD_CHANGE_ENABLED) {
    throw new Error('Password change is not enabled');
  }

  const sessionTokenHashKey = env.SESSION_TOKEN_HASH_KEY;
  const rateLimitHashKey = env.CEREMONY_RATE_LIMIT_HASH_KEY;
  const allowedOriginsRaw = env.WEBAUTHN_ALLOWED_ORIGINS;
  const webSessionCookieName = env.WEB_SESSION_COOKIE_NAME ?? DEFAULT_WEB_SESSION_COOKIE_NAME;

  if (!sessionTokenHashKey || !rateLimitHashKey || !allowedOriginsRaw) {
    throw new Error('Password change secrets are not configured');
  }
  if (sessionTokenHashKey.length < SESSION_TOKEN_HASH_KEY_MIN_LENGTH) {
    throw new Error('Session token hash key does not meet minimum length');
  }

  const allowedOrigins = parseAllowedOrigins(allowedOriginsRaw, {
    nodeEnv: env.NODE_ENV,
    appEnv: env.APP_ENV,
  });

  return {
    enabled: true,
    sessionTokenHashKey,
    rateLimitHashKey,
    webSessionCookieName,
    allowedOrigins,
  };
}
