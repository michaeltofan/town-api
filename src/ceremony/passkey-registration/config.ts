import type { Env } from '../../config/env.js';
import {
  DEFAULT_WEBAUTHN_RP_NAME,
  FORBIDDEN_PRODUCTION_ORIGIN_HOST_PATTERNS,
  isRailwayUpStagingHostname,
  PRODUCTION_ALLOWED_ORIGIN,
  PRODUCTION_ALLOWED_ORIGINS,
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

/** Deployment environment used for browser-origin allowlist policy. */
export type OriginAppEnv = 'development' | 'test' | 'staging' | 'production';

export type ParseAllowedOriginsOptions = {
  readonly nodeEnv: string;
  readonly appEnv: OriginAppEnv;
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

function assertForbiddenPreviewHostname(host: string, appEnv: OriginAppEnv): void {
  for (const pattern of FORBIDDEN_PRODUCTION_ORIGIN_HOST_PATTERNS) {
    if (host === pattern.replace(/\.$/, '') || host.includes(pattern) || host.startsWith(pattern)) {
      throw new Error(
        `Invalid environment configuration: ${appEnv} WEBAUTHN_ALLOWED_ORIGINS rejects temporary, www, API, or preview origins`,
      );
    }
  }
  if (host.startsWith('www.') || host.startsWith('api.')) {
    throw new Error(
      `Invalid environment configuration: ${appEnv} WEBAUTHN_ALLOWED_ORIGINS rejects www and API origins`,
    );
  }
}

function assertValidOrigin(origin: string, options: ParseAllowedOriginsOptions): void {
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
  const host = url.hostname.toLowerCase();
  const { appEnv, nodeEnv } = options;

  if (appEnv === 'production') {
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
    assertForbiddenPreviewHostname(host, 'production');
    return;
  }

  if (appEnv === 'staging') {
    if (isLocal) {
      throw new Error(
        'Invalid environment configuration: staging WEBAUTHN_ALLOWED_ORIGINS cannot allow localhost origins',
      );
    }
    if (url.protocol !== 'https:') {
      throw new Error(
        'Invalid environment configuration: staging WEBAUTHN_ALLOWED_ORIGINS must use https',
      );
    }
    if (url.port !== '') {
      throw new Error(
        'Invalid environment configuration: staging WEBAUTHN_ALLOWED_ORIGINS must not include an explicit port',
      );
    }
    // Deployment policy: APP_ENV=staging may allow exact HTTPS *.up.railway.app
    // service origins even when NODE_ENV=production.
    if (isRailwayUpStagingHostname(host)) {
      return;
    }
    assertForbiddenPreviewHostname(host, 'staging');
    return;
  }

  // development / test — preserve prior non-deploy behavior (NODE_ENV-gated https).
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
    assertForbiddenPreviewHostname(host, 'production');
    return;
  }

  if (!isLocal && url.protocol !== 'https:') {
    throw new Error(
      'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS requires https except explicit localhost development origins',
    );
  }
}

/**
 * Parse and validate the canonical browser-origin allowlist.
 * Deployment classification (including Railway staging hosts) uses `appEnv`.
 * `nodeEnv` is retained for development/test https/localhost behavior.
 */
export function parseAllowedOrigins(raw: string, options: ParseAllowedOriginsOptions): string[] {
  const parts = raw.split(',');
  const origins: string[] = [];
  for (const part of parts) {
    if (part.length === 0) {
      continue;
    }
    if (part !== part.trim()) {
      throw new Error(
        'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS entries must not include surrounding whitespace',
      );
    }
    origins.push(part);
  }
  if (origins.length === 0) {
    throw new Error(
      'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS is required when enabled',
    );
  }
  const unique = new Set<string>();
  for (const origin of origins) {
    assertValidOrigin(origin, options);
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
  const allowed = new Set(PRODUCTION_ALLOWED_ORIGINS);
  const hasPrimary = origins.includes(PRODUCTION_ALLOWED_ORIGIN);
  const hasUnknown = origins.some((origin) => !allowed.has(origin));
  if (!hasPrimary || hasUnknown) {
    throw new Error(
      `Invalid environment configuration: production WEBAUTHN_ALLOWED_ORIGINS must include ${PRODUCTION_ALLOWED_ORIGIN} and contain only origins from {${PRODUCTION_ALLOWED_ORIGINS.join(', ')}}`,
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

  const allowedOrigins = parseAllowedOrigins(allowedOriginsRaw, {
    nodeEnv: env.NODE_ENV,
    appEnv: env.APP_ENV,
  });
  if (env.APP_ENV === 'production') {
    assertProductionWebAuthnPolicy(rpId, allowedOrigins);
  }
  if (env.APP_ENV === 'production' && rpId === 'localhost') {
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
