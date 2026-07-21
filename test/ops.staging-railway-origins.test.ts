import { describe, expect, it } from 'vitest';
import { parseAllowedOrigins } from '../src/ceremony/passkey-registration/config.js';
import {
  isRailwayUpStagingHostname,
  PRODUCTION_ALLOWED_ORIGIN,
} from '../src/ceremony/passkey-registration/policy.js';
import { resolveCorsAllowedOrigins } from '../src/ops/cors-origins.js';
import { createTestApp } from './helpers/app.js';
import { createFakeDatabase } from './helpers/database.js';
import { createTestEnv } from './helpers/env.js';

const STAGING_COMMIT_SHA = '1234567890abcdef1234567890abcdef12345678';
const STG_DATABASE_URL = 'postgres://town-stg:stg-secret@db.internal:5432/town';
const RAILWAY_STAGING_ORIGIN = 'https://town-public-staging-staging.up.railway.app';
const RAILWAY_NESTED_ORIGIN = 'https://svc.region.up.railway.app';

function stagingEnv(
  origins: string,
  overrides: Partial<NodeJS.ProcessEnv> = {},
): ReturnType<typeof createTestEnv> {
  return createTestEnv({
    NODE_ENV: 'production',
    APP_ENV: 'staging',
    APP_COMMIT_SHA: STAGING_COMMIT_SHA,
    DATABASE_URL: STG_DATABASE_URL,
    WEBAUTHN_ALLOWED_ORIGINS: origins,
    ...overrides,
  });
}

describe('isRailwayUpStagingHostname', () => {
  it('accepts service subdomains under up.railway.app', () => {
    expect(isRailwayUpStagingHostname('town-public-staging-staging.up.railway.app')).toBe(true);
    expect(isRailwayUpStagingHostname('svc.region.up.railway.app')).toBe(true);
  });

  it('rejects lookalikes and the suffix apex', () => {
    expect(isRailwayUpStagingHostname('up.railway.app')).toBe(false);
    expect(isRailwayUpStagingHostname('evilrailway.app')).toBe(false);
    expect(isRailwayUpStagingHostname('example.up.railway.app.evil.com')).toBe(false);
    expect(isRailwayUpStagingHostname('evil-up.railway.app')).toBe(false);
    expect(isRailwayUpStagingHostname('railway.app')).toBe(false);
  });
});

describe('APP_ENV staging Railway origin policy', () => {
  it('accepts the town-public staging Railway origin with NODE_ENV=production', () => {
    const origins = parseAllowedOrigins(RAILWAY_STAGING_ORIGIN, {
      nodeEnv: 'production',
      appEnv: 'staging',
    });
    expect(origins).toEqual([RAILWAY_STAGING_ORIGIN]);
    const env = stagingEnv(RAILWAY_STAGING_ORIGIN);
    expect(env.APP_ENV).toBe('staging');
    expect(env.NODE_ENV).toBe('production');
    expect(resolveCorsAllowedOrigins(env)).toEqual([RAILWAY_STAGING_ORIGIN]);
  });

  it('accepts another HTTPS subdomain beneath up.railway.app', () => {
    expect(
      parseAllowedOrigins(RAILWAY_NESTED_ORIGIN, {
        nodeEnv: 'production',
        appEnv: 'staging',
      }),
    ).toEqual([RAILWAY_NESTED_ORIGIN]);
  });

  it('rejects the same Railway origin under APP_ENV=production', () => {
    expect(() =>
      parseAllowedOrigins(RAILWAY_STAGING_ORIGIN, {
        nodeEnv: 'production',
        appEnv: 'production',
      }),
    ).toThrow(/production WEBAUTHN_ALLOWED_ORIGINS rejects temporary/);
    expect(() =>
      createTestEnv({
        NODE_ENV: 'production',
        APP_ENV: 'production',
        APP_COMMIT_SHA: STAGING_COMMIT_SHA,
        DATABASE_URL: 'postgres://town-prod:prod-secret@db.internal:5432/town',
        WEBAUTHN_ALLOWED_ORIGINS: RAILWAY_STAGING_ORIGIN,
      }),
    ).toThrow(/production WEBAUTHN_ALLOWED_ORIGINS rejects temporary/);
  });

  it('rejects the production origin under APP_ENV=staging by default', () => {
    expect(() => resolveCorsAllowedOrigins(stagingEnv(PRODUCTION_ALLOWED_ORIGIN))).toThrow(
      /production origins are not allowed when APP_ENV is staging/,
    );
  });

  it('permits the production web origin under APP_ENV=staging when ALLOW_PRODUCTION_WEB_ORIGIN=true', () => {
    const env = stagingEnv(PRODUCTION_ALLOWED_ORIGIN, {
      ALLOW_PRODUCTION_WEB_ORIGIN: 'true',
    });
    expect(resolveCorsAllowedOrigins(env)).toEqual([PRODUCTION_ALLOWED_ORIGIN]);
  });

  it('rejects http Railway staging origins', () => {
    expect(() =>
      parseAllowedOrigins('http://town-public-staging-staging.up.railway.app', {
        nodeEnv: 'production',
        appEnv: 'staging',
      }),
    ).toThrow(/staging WEBAUTHN_ALLOWED_ORIGINS must use https/);
  });

  it('rejects the up.railway.app apex without a service subdomain', () => {
    expect(() =>
      parseAllowedOrigins('https://up.railway.app', {
        nodeEnv: 'production',
        appEnv: 'staging',
      }),
    ).toThrow(/staging WEBAUTHN_ALLOWED_ORIGINS rejects temporary/);
  });

  it('rejects deceptive Railway hostname lookalikes', () => {
    const rejected = [
      'https://evilrailway.app',
      'https://example.up.railway.app.evil.com',
      'https://evil-up.railway.app',
    ];
    for (const origin of rejected) {
      expect(() =>
        parseAllowedOrigins(origin, { nodeEnv: 'production', appEnv: 'staging' }),
      ).toThrow(/invalid origin|rejects temporary|exact origins/);
    }
  });

  it('rejects trailing slash, path, query, fragment, credentials, and explicit ports', () => {
    const rejected = [
      `${RAILWAY_STAGING_ORIGIN}/`,
      `${RAILWAY_STAGING_ORIGIN}/path`,
      `${RAILWAY_STAGING_ORIGIN}?q=1`,
      `${RAILWAY_STAGING_ORIGIN}#frag`,
      'https://user:pass@town-public-staging-staging.up.railway.app',
      'https://town-public-staging-staging.up.railway.app:8443',
    ];
    for (const origin of rejected) {
      expect(() =>
        parseAllowedOrigins(origin, { nodeEnv: 'production', appEnv: 'staging' }),
      ).toThrow(/exact origins|credentials|explicit port/);
    }
  });

  it('rejects surrounding whitespace without normalizing', () => {
    expect(() =>
      parseAllowedOrigins(` ${RAILWAY_STAGING_ORIGIN}`, {
        nodeEnv: 'production',
        appEnv: 'staging',
      }),
    ).toThrow(/surrounding whitespace/);
    expect(() =>
      parseAllowedOrigins(`${RAILWAY_STAGING_ORIGIN} `, {
        nodeEnv: 'production',
        appEnv: 'staging',
      }),
    ).toThrow(/surrounding whitespace/);
  });

  it('rejects uppercase hostnames without silent normalization', () => {
    expect(() =>
      parseAllowedOrigins('https://Town-Public-Staging-Staging.up.railway.app', {
        nodeEnv: 'production',
        appEnv: 'staging',
      }),
    ).toThrow(/exact origins without path/);
  });

  it('reflects the exact authorized Railway origin and never wildcard ACAO', async () => {
    const app = await createTestApp({
      database: createFakeDatabase({ ready: true }),
      envOverrides: {
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        APP_COMMIT_SHA: STAGING_COMMIT_SHA,
        DATABASE_URL: STG_DATABASE_URL,
        WEBAUTHN_ALLOWED_ORIGINS: RAILWAY_STAGING_ORIGIN,
      },
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: RAILWAY_STAGING_ORIGIN },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(RAILWAY_STAGING_ORIGIN);
      expect(response.headers['access-control-allow-origin']).not.toBe('*');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    } finally {
      await app.close();
    }
  });
});
