import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppInstance } from '../src/app.js';
import { createTestApp } from './helpers/app.js';
import { createFakeDatabase } from './helpers/database.js';
import { EXPECTED_MIGRATION_COUNT } from '../src/db/migration-ledger.js';

describe('/health/ready component checks', () => {
  describe('when everything is healthy', () => {
    let app: AppInstance;

    beforeAll(async () => {
      app = await createTestApp({
        database: createFakeDatabase({ ready: true }),
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it('returns ready with all components ok', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: 'ready',
        checks: { config: 'ok', database: 'ok', migrations: 'ok' },
      });
    });
  });

  describe('when the database connection times out', () => {
    let app: AppInstance;

    beforeAll(async () => {
      app = await createTestApp({
        database: createFakeDatabase({ connectionStatus: 'timeout' }),
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it('returns 503 with database=timeout and migrations=unknown', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: 'not_ready',
        checks: { config: 'ok', database: 'timeout', migrations: 'unknown' },
      });
    });
  });

  describe('when the migration ledger is stale', () => {
    let app: AppInstance;

    beforeAll(async () => {
      app = await createTestApp({
        database: createFakeDatabase({
          connectionStatus: 'ok',
          migrationStatus: 'fail',
        }),
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it('returns 503 with migrations=fail and does not leak counts', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      const body: unknown = response.json();
      expect(body).toEqual({
        status: 'not_ready',
        checks: { config: 'ok', database: 'ok', migrations: 'fail' },
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/drizzle|hash|__drizzle_migrations|SQL/i);
    });
  });

  describe('when the migration ledger is missing', () => {
    let app: AppInstance;

    beforeAll(async () => {
      app = await createTestApp({
        database: createFakeDatabase({
          connectionStatus: 'ok',
          migrationStatus: 'unknown',
        }),
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it('returns 503 with migrations=unknown', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: 'not_ready',
        checks: { config: 'ok', database: 'ok', migrations: 'unknown' },
      });
    });
  });

  describe('when the app is shutting down', () => {
    let app: AppInstance;

    beforeAll(async () => {
      app = await createTestApp({
        database: createFakeDatabase({ ready: true }),
      });
      app.isShuttingDown = true;
    });

    afterAll(async () => {
      app.isShuttingDown = false;
      await app.close();
    });

    it('fails readiness immediately without probing the database', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: 'not_ready',
        checks: { config: 'ok', database: 'fail', migrations: 'unknown' },
      });
    });
  });
});

describe('/health/build', () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = await createTestApp({
      envOverrides: {
        APP_ENV: 'staging',
        APP_COMMIT_SHA: '1234567890abcdef1234567890abcdef12345678',
        APP_BUILD_TIMESTAMP: '2026-07-17T00:00:00Z',
        DATABASE_URL: 'postgres://town-stg:stg-secret@db.internal:5432/town',
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the exact build identity envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/build' });
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toEqual({
      data: {
        service: 'town-api',
        version: expect.any(String) as string,
        commitSha: '1234567890abcdef1234567890abcdef12345678',
        environment: 'staging',
        nodeVersion: process.version,
        buildTimestamp: '2026-07-17T00:00:00Z',
        expectedMigrationCount: EXPECTED_MIGRATION_COUNT,
      },
    });
  });

  it('does not leak secrets, connection strings, or headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/build' });
    const serialized = response.body;
    expect(serialized).not.toMatch(
      /postgres:|DATABASE_URL|password|127\.0\.0\.1|db\.internal|stg-secret|sk_|whsec_/i,
    );
    expect(serialized).not.toMatch(/RAILWAY_GIT_COMMIT_SHA|APP_COMMIT_SHA/i);
  });
});

describe('/health/build with RAILWAY_GIT_COMMIT_SHA', () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = await createTestApp({
      envOverrides: {
        APP_ENV: 'staging',
        RAILWAY_GIT_COMMIT_SHA: 'abcdef0123456789abcdef0123456789abcdef01',
        DATABASE_URL: 'postgres://town-stg:stg-secret@db.internal:5432/town',
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports the resolved Railway SHA as data.commitSha without raw env keys', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/build' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: { commitSha: string | null; environment: string };
    };
    expect(body.data.commitSha).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(body.data.environment).toBe('staging');
    expect(response.body).not.toMatch(/RAILWAY_GIT_COMMIT_SHA|APP_COMMIT_SHA|DATABASE_URL/i);
  });
});
