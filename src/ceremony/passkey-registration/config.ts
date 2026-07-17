import type { Env } from '../../config/env.js';
import {
  DEFAULT_WEBAUTHN_RP_NAME,
  FORBIDDEN_PRODUCTION_ORIGIN_HOST_PATTERNS,
  PRODUCTION_ALLOWED_ORIGIN,
  PRODUCTION_RP_ID,
  WEBAUTHN_CHALLENGE_HASH_KEY_MIN_LENGTH,
} from './policy.js';

export type WebAuthnRegistrationConfig = {
  enabled: true;
  rpId: string;
  rpName: string;
  allowedOrigins: readonly string[];
  challengeHashKey: string;
  rateLimitHashKey: string;
  setupGrantHashKey: string;
};

function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

function assertNoWildcard(origin: string): void {
  if (origin.includes('*')) {
    throw new Error(
      'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS must not include wildcards',
    );
  }
}

function assertValidOrigin(origin: string, nodeEnv: string): void {
  assertNoWildcard(origin);
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(
      'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS contains an invalid origin',
    );
  }
  if (url.origin !== origin) {
    throw new Error(
      'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS entries must be exact origins without path',
    );
  }
  if (url.username || url.password) {
    throw new Error(
      'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS must not include credentials',
    );
  }

  const isLocal = isLocalhostOrigin(origin);
  if (nodeEnv === 'production') {
    if (isLocal) {
      throw new Error(
        'Invalid environment configuration: production WebAuthn configuration cannot allow localhost origins',
      );
    }
    if (url.protocol !== 'https:') {
      throw new Error(
        'Invalid environment configuration: production WEBAUTHN_ALLOWED_ORIGINS must use https',
      );
    }
    const host = url.hostname.toLowerCase();
    for (const pattern of FORBIDDEN_PRODUCTION_ORIGIN_HOST_PATTERNS) {
      if (
        host === pattern.replace(/\.$/, '') ||
        host.includes(pattern) ||
        host.startsWith(pattern)
      ) {
        throw new Error(
          'Invalid environment configuration: production WEBAUTHN_ALLOWED_ORIGINS rejects temporary, www, API, or preview origins',
        );
      }
    }
    if (host.startsWith('www.') || host.startsWith('api.')) {
      throw new Error(
        'Invalid environment configuration: production WEBAUTHN_ALLOWED_ORIGINS rejects www and API origins',
      );
    }
  } else if (!isLocal && url.protocol !== 'https:') {
    throw new Error(
      'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS requires https except explicit localhost development origins',
    );
  }
}

export function parseAllowedOrigins(raw: string, nodeEnv: string): string[] {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new Error(
      'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS is required when enabled',
    );
  }
  const unique = new Set<string>();
  for (const origin of parts) {
    assertValidOrigin(origin, nodeEnv);
    if (unique.has(origin)) {
      throw new Error(
        'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS contains duplicates',
      );
    }
    unique.add(origin);
  }
  return [...unique];
}

export function assertProductionWebAuthnPolicy(rpId: string, origins: readonly string[]): void {
  if (rpId !== PRODUCTION_RP_ID) {
    throw new Error(
      `Invalid environment configuration: production WEBAUTHN_RP_ID must be exactly ${PRODUCTION_RP_ID}`,
    );
  }
  if (origins.length !== 1 || origins[0] !== PRODUCTION_ALLOWED_ORIGIN) {
    throw new Error(
      `Invalid environment configuration: production WEBAUTHN_ALLOWED_ORIGINS must be exactly ${PRODUCTION_ALLOWED_ORIGIN}`,
    );
  }
}

/**
 * Resolve enabled WebAuthn registration configuration from validated env.
 * RP ID and origins are server-owned; never derived from request Host/Origin headers.
 */
export function requireWebAuthnRegistrationConfig(env: Env): WebAuthnRegistrationConfig {
  if (!env.WEBAUTHN_REGISTRATION_ENABLED) {
    throw new Error('WebAuthn registration is not enabled');
  }
  const rpId = env.WEBAUTHN_RP_ID;
  const rpName = env.WEBAUTHN_RP_NAME ?? DEFAULT_WEBAUTHN_RP_NAME;
  const allowedOriginsRaw = env.WEBAUTHN_ALLOWED_ORIGINS;
  const challengeHashKey = env.WEBAUTHN_CHALLENGE_HASH_KEY;
  const rateLimitHashKey = env.CEREMONY_RATE_LIMIT_HASH_KEY;
  const setupGrantHashKey = env.EMAIL_VERIFICATION_HASH_KEY;

  if (!rpId || !allowedOriginsRaw || !challengeHashKey || !rateLimitHashKey || !setupGrantHashKey) {
    throw new Error('WebAuthn registration secrets are not configured');
  }
  if (challengeHashKey.length < WEBAUTHN_CHALLENGE_HASH_KEY_MIN_LENGTH) {
    throw new Error('WebAuthn challenge hash key does not meet minimum length');
  }

  const allowedOrigins = parseAllowedOrigins(allowedOriginsRaw, env.NODE_ENV);
  if (env.NODE_ENV === 'production') {
    assertProductionWebAuthnPolicy(rpId, allowedOrigins);
  }
  if (env.NODE_ENV === 'production' && rpId === 'localhost') {
    throw new Error('Invalid environment configuration: production cannot use localhost RP ID');
  }

  return {
    enabled: true,
    rpId,
    rpName,
    allowedOrigins,
    challengeHashKey,
    rateLimitHashKey,
    setupGrantHashKey,
  };
}
