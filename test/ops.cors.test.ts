import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { createFakeDatabase } from './helpers/database.js';
import {
  CORS_ALLOWED_METHODS,
  CORS_MAX_AGE_SECONDS,
  resolveCorsAllowedOrigins,
  STAGING_ALLOWED_ORIGIN,
} from '../src/ops/cors-origins.js';
import { createTestEnv } from './helpers/env.js';
import { PRODUCTION_ALLOWED_ORIGIN } from '../src/ceremony/passkey-registration/policy.js';

const TEST_ORIGIN = 'http://localhost:5173';

describe('resolveCorsAllowedOrigins', () => {
  it('returns an empty allowlist when origins are unset', () => {
    const env = createTestEnv();
    expect(resolveCorsAllowedOrigins(env)).toEqual([]);
  });

  it('parses exact configured origins', () => {
    const env = createTestEnv({ WEBAUTHN_ALLOWED_ORIGINS: TEST_ORIGIN });
    expect(resolveCorsAllowedOrigins(env)).toEqual([TEST_ORIGIN]);
  });

  it('rejects staging/production mixed origins', () => {
    expect(() =>
      resolveCorsAllowedOrigins(
        createTestEnv({
          NODE_ENV: 'development',
          APP_ENV: 'development',
          WEBAUTHN_ALLOWED_ORIGINS: `${PRODUCTION_ALLOWED_ORIGIN},${STAGING_ALLOWED_ORIGIN}`,
        }),
      ),
    ).toThrow(/must not mix staging and production/);
  });

  it('rejects production origins when APP_ENV is staging by default', () => {
    expect(() =>
      resolveCorsAllowedOrigins(
        createTestEnv({
          NODE_ENV: 'development',
          APP_ENV: 'staging',
          APP_COMMIT_SHA: '1234567890abcdef1234567890abcdef12345678',
          WEBAUTHN_ALLOWED_ORIGINS: PRODUCTION_ALLOWED_ORIGIN,
        }),
      ),
    ).toThrow(/production origins are not allowed when APP_ENV is staging/);
  });

  it('allows exact production web origin on staging when ALLOW_PRODUCTION_WEB_ORIGIN is true', () => {
    expect(
      resolveCorsAllowedOrigins(
        createTestEnv({
          NODE_ENV: 'production',
          APP_ENV: 'staging',
          APP_COMMIT_SHA: '1234567890abcdef1234567890abcdef12345678',
          DATABASE_URL: 'postgres://town-stg:stg-secret@db.internal:5432/town',
          WEBAUTHN_ALLOWED_ORIGINS: PRODUCTION_ALLOWED_ORIGIN,
          ALLOW_PRODUCTION_WEB_ORIGIN: 'true',
        }),
      ),
    ).toEqual([PRODUCTION_ALLOWED_ORIGIN]);
  });

  it('still rejects staging/production mix even when ALLOW_PRODUCTION_WEB_ORIGIN is true', () => {
    expect(() =>
      resolveCorsAllowedOrigins(
        createTestEnv({
          NODE_ENV: 'development',
          APP_ENV: 'staging',
          APP_COMMIT_SHA: '1234567890abcdef1234567890abcdef12345678',
          WEBAUTHN_ALLOWED_ORIGINS: `${PRODUCTION_ALLOWED_ORIGIN},${STAGING_ALLOWED_ORIGIN}`,
          ALLOW_PRODUCTION_WEB_ORIGIN: 'true',
        }),
      ),
    ).toThrow(/must not mix staging and production/);
  });

  it('does not change production APP_ENV behavior when ALLOW_PRODUCTION_WEB_ORIGIN is true', () => {
    expect(
      resolveCorsAllowedOrigins(
        createTestEnv({
          NODE_ENV: 'production',
          APP_ENV: 'production',
          APP_COMMIT_SHA: '1234567890abcdef1234567890abcdef12345678',
          DATABASE_URL: 'postgres://town-prod:prod-secret@db.internal:5432/town',
          WEBAUTHN_ALLOWED_ORIGINS: PRODUCTION_ALLOWED_ORIGIN,
          ALLOW_PRODUCTION_WEB_ORIGIN: 'true',
        }),
      ),
    ).toEqual([PRODUCTION_ALLOWED_ORIGIN]);
    expect(() =>
      resolveCorsAllowedOrigins(
        createTestEnv({
          NODE_ENV: 'production',
          APP_ENV: 'production',
          APP_COMMIT_SHA: '1234567890abcdef1234567890abcdef12345678',
          DATABASE_URL: 'postgres://town-prod:prod-secret@db.internal:5432/town',
          WEBAUTHN_ALLOWED_ORIGINS: STAGING_ALLOWED_ORIGIN,
          ALLOW_PRODUCTION_WEB_ORIGIN: 'true',
        }),
      ),
    ).toThrow(/staging origins are not allowed when APP_ENV is production/);
  });

  it('accepts a Railway *.up.railway.app origin when APP_ENV is staging and NODE_ENV is production', () => {
    const railwayOrigin = 'https://town-public-staging-staging.up.railway.app';
    expect(
      resolveCorsAllowedOrigins(
        createTestEnv({
          NODE_ENV: 'production',
          APP_ENV: 'staging',
          APP_COMMIT_SHA: '1234567890abcdef1234567890abcdef12345678',
          DATABASE_URL: 'postgres://town-stg:stg-secret@db.internal:5432/town',
          WEBAUTHN_ALLOWED_ORIGINS: railwayOrigin,
        }),
      ),
    ).toEqual([railwayOrigin]);
  });
});

describe('runtime CORS policy', () => {
  it('accepts an exact authorized origin and sets credentials', async () => {
    const app = await createTestApp({
      database: createFakeDatabase({ ready: true }),
      envOverrides: { WEBAUTHN_ALLOWED_ORIGINS: TEST_ORIGIN },
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: TEST_ORIGIN },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    } finally {
      await app.close();
    }
  });

  it('rejects an unauthorized origin', async () => {
    const app = await createTestApp({
      database: createFakeDatabase({ ready: true }),
      envOverrides: { WEBAUTHN_ALLOWED_ORIGINS: TEST_ORIGIN },
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: 'https://evil.example' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('rejects the literal null origin', async () => {
    const app = await createTestApp({
      database: createFakeDatabase({ ready: true }),
      envOverrides: { WEBAUTHN_ALLOWED_ORIGINS: TEST_ORIGIN },
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: 'null' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('keeps no-Origin native/server requests functional without ACAO', async () => {
    const app = await createTestApp({
      database: createFakeDatabase({ ready: true }),
      envOverrides: { WEBAUTHN_ALLOWED_ORIGINS: TEST_ORIGIN },
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('answers authorized preflight with methods, headers, and bounded max-age', async () => {
    const app = await createTestApp({
      database: createFakeDatabase({ ready: true }),
      envOverrides: { WEBAUTHN_ALLOWED_ORIGINS: TEST_ORIGIN },
    });
    try {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/health/live',
        headers: {
          origin: TEST_ORIGIN,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'content-type,authorization',
        },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
      const methodsHeader = response.headers['access-control-allow-methods'];
      const methods = typeof methodsHeader === 'string' ? methodsHeader : '';
      for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
        expect(methods.toUpperCase()).toContain(method);
      }
      expect(CORS_ALLOWED_METHODS).toContain('GET');
      const maxAgeHeader = response.headers['access-control-max-age'];
      const maxAgeRaw = typeof maxAgeHeader === 'string' ? maxAgeHeader : '0';
      expect(Number.parseInt(maxAgeRaw, 10)).toBe(CORS_MAX_AGE_SECONDS);
      const allowHeadersHeader = response.headers['access-control-allow-headers'];
      const allowHeaders = typeof allowHeadersHeader === 'string' ? allowHeadersHeader : '';
      expect(allowHeaders.toLowerCase()).toContain('authorization');
      expect(allowHeaders.toLowerCase()).toContain('content-type');
    } finally {
      await app.close();
    }
  });

  it('does not reflect unauthorized preflight origins', async () => {
    const app = await createTestApp({
      database: createFakeDatabase({ ready: true }),
      envOverrides: { WEBAUTHN_ALLOWED_ORIGINS: TEST_ORIGIN },
    });
    try {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/health/live',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'GET',
        },
      });
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('reflects production web origin on staging when ALLOW_PRODUCTION_WEB_ORIGIN is true', async () => {
    const app = await createTestApp({
      database: createFakeDatabase({ ready: true }),
      envOverrides: {
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        APP_COMMIT_SHA: '1234567890abcdef1234567890abcdef12345678',
        DATABASE_URL: 'postgres://town-stg:stg-secret@db.internal:5432/town',
        WEBAUTHN_ALLOWED_ORIGINS: PRODUCTION_ALLOWED_ORIGIN,
        ALLOW_PRODUCTION_WEB_ORIGIN: 'true',
      },
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: PRODUCTION_ALLOWED_ORIGIN },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(PRODUCTION_ALLOWED_ORIGIN);
    } finally {
      await app.close();
    }
  });

  // Pilot Madrid M8: the exact WEBAUTHN_ALLOWED_ORIGINS value confirmed live on
  // town-api-staging (PILOT_MADRID_EVIDENCE.md), reproduced against a real
  // Fastify instance instead of only traced through source.
  it('reflects the Madrid pilot origin under the real three-origin Staging value', async () => {
    const railwayOrigin = 'https://town-public-staging-staging.up.railway.app';
    const madridOrigin = 'https://madrid-staging.towncivic.org';
    const app = await createTestApp({
      database: createFakeDatabase({ ready: true }),
      envOverrides: {
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        APP_COMMIT_SHA: '1234567890abcdef1234567890abcdef12345678',
        DATABASE_URL: 'postgres://town-stg:stg-secret@db.internal:5432/town',
        WEBAUTHN_ALLOWED_ORIGINS: `${PRODUCTION_ALLOWED_ORIGIN},${railwayOrigin},${madridOrigin}`,
        ALLOW_PRODUCTION_WEB_ORIGIN: 'true',
      },
    });
    try {
      const madridResponse = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: madridOrigin },
      });
      expect(madridResponse.statusCode).toBe(200);
      expect(madridResponse.headers['access-control-allow-origin']).toBe(madridOrigin);
      expect(madridResponse.headers['access-control-allow-credentials']).toBe('true');

      // The two pre-existing origins still work -- adding Madrid changed nothing else.
      const productionResponse = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: PRODUCTION_ALLOWED_ORIGIN },
      });
      expect(productionResponse.headers['access-control-allow-origin']).toBe(
        PRODUCTION_ALLOWED_ORIGIN,
      );

      const railwayResponse = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: railwayOrigin },
      });
      expect(railwayResponse.headers['access-control-allow-origin']).toBe(railwayOrigin);

      // A lookalike host must still be rejected.
      const lookalikeResponse = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: 'https://evil-madrid-staging.towncivic.org' },
      });
      expect(lookalikeResponse.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('answers an authorized preflight for the Madrid origin with credentials allowed', async () => {
    const railwayOrigin = 'https://town-public-staging-staging.up.railway.app';
    const madridOrigin = 'https://madrid-staging.towncivic.org';
    const app = await createTestApp({
      database: createFakeDatabase({ ready: true }),
      envOverrides: {
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        APP_COMMIT_SHA: '1234567890abcdef1234567890abcdef12345678',
        DATABASE_URL: 'postgres://town-stg:stg-secret@db.internal:5432/town',
        WEBAUTHN_ALLOWED_ORIGINS: `${PRODUCTION_ALLOWED_ORIGIN},${railwayOrigin},${madridOrigin}`,
        ALLOW_PRODUCTION_WEB_ORIGIN: 'true',
      },
    });
    try {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/health/live',
        headers: {
          origin: madridOrigin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'content-type,authorization',
        },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(madridOrigin);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    } finally {
      await app.close();
    }
  });
});
