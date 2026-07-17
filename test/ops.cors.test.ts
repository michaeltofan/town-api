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

  it('rejects production origins when APP_ENV is staging', () => {
    expect(() =>
      resolveCorsAllowedOrigins(
        createTestEnv({
          NODE_ENV: 'development',
          APP_ENV: 'staging',
          APP_COMMIT_SHA: 'abc123',
          WEBAUTHN_ALLOWED_ORIGINS: PRODUCTION_ALLOWED_ORIGIN,
        }),
      ),
    ).toThrow(/production origins are not allowed when APP_ENV is staging/);
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
      const methods = String(response.headers['access-control-allow-methods'] ?? '');
      for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
        expect(methods.toUpperCase()).toContain(method);
      }
      expect(CORS_ALLOWED_METHODS).toContain('GET');
      expect(Number.parseInt(String(response.headers['access-control-max-age']), 10)).toBe(
        CORS_MAX_AGE_SECONDS,
      );
      const allowHeaders = String(response.headers['access-control-allow-headers'] ?? '');
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
});
