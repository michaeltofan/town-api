import type { Env } from '../../config/env.js';
import {
  assertProductionWebAuthnPolicy,
  parseAllowedOrigins,
} from '../passkey-registration/config.js';
import { DEFAULT_WEBAUTHN_RP_NAME } from '../passkey-registration/policy.js';
import {
  DEFAULT_WEB_SESSION_COOKIE_NAME,
  PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY_MIN_LENGTH,
  SESSION_TOKEN_HASH_KEY_MIN_LENGTH,
} from './policy.js';

export type PasskeyAuthenticationConfig = {
  enabled: true;
  rpId: string;
  rpName: string;
  allowedOrigins: readonly string[];
  challengeHashKey: string;
  sessionTokenHashKey: string;
  rateLimitHashKey: string;
  webSessionCookieName: string;
};

export function requirePasskeyAuthenticationConfig(env: Env): PasskeyAuthenticationConfig {
  if (!env.PASSKEY_AUTHENTICATION_ENABLED) {
    throw new Error('Passkey authentication is not enabled');
  }

  const rpId = env.WEBAUTHN_RP_ID;
  const rpName = env.WEBAUTHN_RP_NAME ?? DEFAULT_WEBAUTHN_RP_NAME;
  const allowedOriginsRaw = env.WEBAUTHN_ALLOWED_ORIGINS;
  const challengeHashKey = env.PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY;
  const sessionTokenHashKey = env.SESSION_TOKEN_HASH_KEY;
  const rateLimitHashKey = env.CEREMONY_RATE_LIMIT_HASH_KEY;
  const webSessionCookieName = env.WEB_SESSION_COOKIE_NAME ?? DEFAULT_WEB_SESSION_COOKIE_NAME;

  if (
    !rpId ||
    !allowedOriginsRaw ||
    !challengeHashKey ||
    !sessionTokenHashKey ||
    !rateLimitHashKey
  ) {
    throw new Error('Passkey authentication secrets are not configured');
  }
  if (challengeHashKey.length < PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY_MIN_LENGTH) {
    throw new Error('Passkey authentication challenge hash key does not meet minimum length');
  }
  if (sessionTokenHashKey.length < SESSION_TOKEN_HASH_KEY_MIN_LENGTH) {
    throw new Error('Session token hash key does not meet minimum length');
  }

  const allowedOrigins = parseAllowedOrigins(allowedOriginsRaw, {
    nodeEnv: env.NODE_ENV,
    appEnv: env.APP_ENV,
  });
  if (env.NODE_ENV === 'production') {
    assertProductionWebAuthnPolicy(rpId, allowedOrigins);
  }

  return {
    enabled: true,
    rpId,
    rpName,
    allowedOrigins,
    challengeHashKey,
    sessionTokenHashKey,
    rateLimitHashKey,
    webSessionCookieName,
  };
}
