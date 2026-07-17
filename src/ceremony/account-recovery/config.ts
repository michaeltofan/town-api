import type { Env } from '../../config/env.js';
import {
  assertProductionWebAuthnPolicy,
  parseAllowedOrigins,
} from '../passkey-registration/config.js';
import {
  DEFAULT_WEBAUTHN_RP_NAME,
  WEBAUTHN_CHALLENGE_HASH_KEY_MIN_LENGTH,
} from '../passkey-registration/policy.js';
import {
  ACCOUNT_RECOVERY_HASH_KEY_MIN_LENGTH,
  ACCOUNT_RECOVERY_TOKEN_HASH_KEY_MIN_LENGTH,
} from './policy.js';

export type AccountRecoveryConfig = {
  enabled: true;
  hashKey: string;
  tokenHashKey: string;
  rateLimitHashKey: string;
  challengeHashKey: string;
  rpId: string;
  rpName: string;
  allowedOrigins: readonly string[];
};

/**
 * Resolve enabled account recovery configuration from validated env.
 * Recovery reuses WebAuthn RP/origin/challenge hashing for recover_register ceremonies.
 */
export function requireAccountRecoveryConfig(env: Env): AccountRecoveryConfig {
  if (!env.ACCOUNT_RECOVERY_ENABLED) {
    throw new Error('Account recovery is not enabled');
  }

  const hashKey = env.ACCOUNT_RECOVERY_HASH_KEY;
  const tokenHashKey = env.ACCOUNT_RECOVERY_TOKEN_HASH_KEY;
  const rateLimitHashKey = env.CEREMONY_RATE_LIMIT_HASH_KEY;
  const challengeHashKey = env.WEBAUTHN_CHALLENGE_HASH_KEY;
  const rpId = env.WEBAUTHN_RP_ID;
  const allowedOriginsRaw = env.WEBAUTHN_ALLOWED_ORIGINS;
  const rpName = env.WEBAUTHN_RP_NAME ?? DEFAULT_WEBAUTHN_RP_NAME;

  if (
    !hashKey ||
    !tokenHashKey ||
    !rateLimitHashKey ||
    !challengeHashKey ||
    !rpId ||
    !allowedOriginsRaw
  ) {
    throw new Error('Account recovery secrets are not configured');
  }
  if (hashKey.length < ACCOUNT_RECOVERY_HASH_KEY_MIN_LENGTH) {
    throw new Error('Account recovery hash key does not meet minimum length');
  }
  if (tokenHashKey.length < ACCOUNT_RECOVERY_TOKEN_HASH_KEY_MIN_LENGTH) {
    throw new Error('Account recovery token hash key does not meet minimum length');
  }
  if (challengeHashKey.length < WEBAUTHN_CHALLENGE_HASH_KEY_MIN_LENGTH) {
    throw new Error('WebAuthn challenge hash key does not meet minimum length');
  }

  const allowedOrigins = parseAllowedOrigins(allowedOriginsRaw, env.NODE_ENV);
  if (env.NODE_ENV === 'production') {
    assertProductionWebAuthnPolicy(rpId, allowedOrigins);
  }

  return {
    enabled: true,
    hashKey,
    tokenHashKey,
    rateLimitHashKey,
    challengeHashKey,
    rpId,
    rpName,
    allowedOrigins,
  };
}
