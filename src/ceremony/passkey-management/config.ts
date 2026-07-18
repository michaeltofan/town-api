import type { Env } from '../../config/env.js';
import { requirePasskeyAuthenticationConfig } from '../passkey-authentication/config.js';
import {
  assertProductionWebAuthnPolicy,
  parseAllowedOrigins,
} from '../passkey-registration/config.js';
import { DEFAULT_WEBAUTHN_RP_NAME } from '../passkey-registration/policy.js';
import { WEBAUTHN_CHALLENGE_HASH_KEY_MIN_LENGTH } from '../passkey-registration/policy.js';

export type PasskeyManagementConfig = {
  enabled: true;
  rpId: string;
  rpName: string;
  allowedOrigins: readonly string[];
  challengeHashKey: string;
  sessionTokenHashKey: string;
  rateLimitHashKey: string;
  webSessionCookieName: string;
};

/**
 * Management runtime reuses session auth + WebAuthn RP/challenge configuration.
 * No dedicated feature flag: requires PASSKEY_AUTHENTICATION_ENABLED and WEBAUTHN_CHALLENGE_HASH_KEY.
 */
export function requirePasskeyManagementConfig(env: Env): PasskeyManagementConfig {
  const auth = requirePasskeyAuthenticationConfig(env);
  const challengeHashKey =
    env.WEBAUTHN_CHALLENGE_HASH_KEY ?? env.PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY;
  if (!challengeHashKey || challengeHashKey.length < WEBAUTHN_CHALLENGE_HASH_KEY_MIN_LENGTH) {
    throw new Error(
      'Passkey management requires WEBAUTHN_CHALLENGE_HASH_KEY or PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY',
    );
  }

  const rpName = env.WEBAUTHN_RP_NAME ?? DEFAULT_WEBAUTHN_RP_NAME;
  const allowedOriginsRaw = env.WEBAUTHN_ALLOWED_ORIGINS;
  if (!allowedOriginsRaw) {
    throw new Error('Passkey management secrets are not configured');
  }
  const allowedOrigins = parseAllowedOrigins(allowedOriginsRaw, {
    nodeEnv: env.NODE_ENV,
    appEnv: env.APP_ENV,
  });
  if (env.NODE_ENV === 'production') {
    assertProductionWebAuthnPolicy(auth.rpId, allowedOrigins);
  }

  return {
    enabled: true,
    rpId: auth.rpId,
    rpName,
    allowedOrigins,
    challengeHashKey,
    sessionTokenHashKey: auth.sessionTokenHashKey,
    rateLimitHashKey: auth.rateLimitHashKey,
    webSessionCookieName: auth.webSessionCookieName,
  };
}
