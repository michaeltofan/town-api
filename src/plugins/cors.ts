import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Env } from '../config/env.js';
import { PRODUCTION_ALLOWED_ORIGIN } from '../ceremony/passkey-registration/policy.js';
import {
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  CORS_MAX_AGE_SECONDS,
  resolveCorsAllowedOrigins,
} from '../ops/cors-origins.js';

export type CorsPluginOptions = {
  env: Env;
};

/**
 * Exact-allowlist CORS for browser clients.
 *
 * - Reflects only origins present in `WEBAUTHN_ALLOWED_ORIGINS`.
 * - Rejects `null`, malformed, and unauthorized Origins (no ACAO reflection).
 * - Leaves non-browser/native requests without an `Origin` header functional.
 * - Never uses wildcard origins.
 * - Does not implement authentication or authorization.
 */
const corsPlugin = async (app: FastifyInstance, options: CorsPluginOptions): Promise<void> => {
  const allowedOrigins = resolveCorsAllowedOrigins(options.env);
  const allowed = new Set(allowedOrigins);

  if (
    options.env.APP_ENV === 'staging' &&
    options.env.ALLOW_PRODUCTION_WEB_ORIGIN &&
    allowed.has(PRODUCTION_ALLOWED_ORIGIN)
  ) {
    app.log.warn(
      {
        event: 'production_origin_override_active',
        origin: PRODUCTION_ALLOWED_ORIGIN,
        appEnv: options.env.APP_ENV,
      },
      'ALLOW_PRODUCTION_WEB_ORIGIN permits production web origin on staging API',
    );
  }

  await app.register(cors, {
    credentials: true,
    methods: [...CORS_ALLOWED_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    maxAge: CORS_MAX_AGE_SECONDS,
    strictPreflight: true,
    hideOptionsRoute: true,
    origin: (requestOrigin, callback) => {
      // No Origin: native / server / non-browser clients — do not reflect CORS.
      if (requestOrigin === undefined || requestOrigin === '') {
        callback(null, false);
        return;
      }
      // Literal "null" (opaque origins) and anything not exactly allowlisted.
      if (requestOrigin === 'null' || !allowed.has(requestOrigin)) {
        callback(null, false);
        return;
      }
      // Exact match: reflect the request origin.
      callback(null, true);
    },
  });
};

export default fp(corsPlugin, {
  name: 'town-cors',
});
