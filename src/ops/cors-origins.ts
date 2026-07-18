import type { Env } from '../config/env.js';
import { parseAllowedOrigins } from '../ceremony/passkey-registration/config.js';
import { PRODUCTION_ALLOWED_ORIGIN } from '../ceremony/passkey-registration/policy.js';

/** Staging web origin from the authentication ceremony contract. */
export const STAGING_ALLOWED_ORIGIN = 'https://staging.towncivic.org';

/**
 * Resolve the exact CORS allowlist from the canonical
 * `WEBAUTHN_ALLOWED_ORIGINS` configuration.
 *
 * - No wildcards (enforced by `parseAllowedOrigins`).
 * - Empty when unset: browser Origins are rejected; no-Origin clients still work.
 * - Rejects staging/production origin mixtures when detectable.
 * - Deployment host policy (including Railway `*.up.railway.app` on staging)
 *   is classified by `APP_ENV`, not `NODE_ENV`.
 */
export function resolveCorsAllowedOrigins(env: Env): readonly string[] {
  const raw = env.WEBAUTHN_ALLOWED_ORIGINS;
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }

  const origins = parseAllowedOrigins(raw, {
    nodeEnv: env.NODE_ENV,
    appEnv: env.APP_ENV,
  });
  const hasProduction = origins.includes(PRODUCTION_ALLOWED_ORIGIN);
  const hasStaging = origins.includes(STAGING_ALLOWED_ORIGIN);

  if (hasProduction && hasStaging) {
    throw new Error(
      'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS must not mix staging and production origins',
    );
  }

  if (env.APP_ENV === 'production' && hasStaging) {
    throw new Error(
      'Invalid environment configuration: staging origins are not allowed when APP_ENV is production',
    );
  }

  if (env.APP_ENV === 'staging' && hasProduction) {
    throw new Error(
      'Invalid environment configuration: production origins are not allowed when APP_ENV is staging',
    );
  }

  if (env.APP_ENV === 'production') {
    for (const origin of origins) {
      const lower = origin.toLowerCase();
      if (lower.includes('localhost') || lower.includes('127.0.0.1')) {
        throw new Error(
          'Invalid environment configuration: WEBAUTHN_ALLOWED_ORIGINS must not include localhost in production',
        );
      }
    }
  }

  return origins;
}

/** HTTP methods permitted for cross-origin requests. */
export const CORS_ALLOWED_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;

/**
 * Request headers browsers may send on cross-origin API calls.
 * CORS is not authentication — session/control-key/Stripe checks remain separate.
 */
export const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Request-Id',
  'X-TOWN-Control-Key',
  'Stripe-Signature',
] as const;

/** Bounded preflight cache (10 minutes). */
export const CORS_MAX_AGE_SECONDS = 600;
