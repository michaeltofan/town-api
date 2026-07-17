import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppInstance } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { loadEnv } from '../src/config/env.js';

function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error('DATABASE_URL must be set for PostgreSQL integration tests');
  }
  return value;
}

describe('database readiness with real PostgreSQL', () => {
  const databaseUrl = requireDatabaseUrl();
  let app: AppInstance;

  beforeAll(async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      DATABASE_URL: databaseUrl,
      DB_POOL_MAX: '2',
      DB_CONNECTION_TIMEOUT_MS: '3000',
      DB_IDLE_TIMEOUT_MS: '1000',
    });

    const database = createDatabase({
      connectionString: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
    });

    app = await buildApp({
      env,
      logger: false,
      database,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/ready returns exact 200 body against real PostgreSQL', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual({
      status: 'ready',
      checks: { config: 'ok', database: 'ok', migrations: 'ok' },
    });
  });

  it('GET /health/live remains exact and independent of PostgreSQL', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('Fastify app closes without leaving open handles', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      DB_POOL_MAX: '1',
      DB_CONNECTION_TIMEOUT_MS: '2000',
      DB_IDLE_TIMEOUT_MS: '1000',
    });

    const localApp = await buildApp({
      env,
      logger: false,
      database: createDatabase({
        connectionString: env.DATABASE_URL,
        poolMax: env.DB_POOL_MAX,
        connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
        idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
      }),
    });

    await localApp.ready();
    await expect(localApp.close()).resolves.toBeUndefined();
  });
});
