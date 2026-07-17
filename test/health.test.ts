import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppInstance } from '../src/app.js';
import { createFakeDatabase } from './helpers/database.js';
import { createTestApp } from './helpers/app.js';

describe('health endpoints', () => {
  describe('with healthy database dependency', () => {
    let app: AppInstance;
    let readinessCalls = 0;

    beforeAll(async () => {
      const database = createFakeDatabase({
        ready: true,
        onCheckReadiness: () => {
          readinessCalls += 1;
        },
      });
      app = await createTestApp({ database });
    });

    afterAll(async () => {
      await app.close();
    });

    it('GET /health/live returns exact liveness body without database readiness', async () => {
      const before = readinessCalls;
      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.json()).toEqual({ status: 'ok' });
      expect(readinessCalls).toBe(before);
    });

    it('GET /health/ready returns exact readiness body when database is healthy', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      const body: unknown = response.json();
      expect(body).toEqual({
        status: 'ready',
        checks: { config: 'ok', database: 'ok', migrations: 'ok' },
      });
      expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(['checks', 'status']);
    });
  });

  describe('with unavailable database dependency', () => {
    let app: AppInstance;

    beforeAll(async () => {
      app = await createTestApp({
        database: createFakeDatabase({ ready: false }),
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it('GET /health/ready returns exact 503 body when database is unavailable', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(503);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      const body: unknown = response.json();
      expect(body).toEqual({
        status: 'not_ready',
        checks: { config: 'ok', database: 'fail', migrations: 'unknown' },
      });
      expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(['checks', 'status']);

      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/postgres|DATABASE_URL|SQLSTATE|password|127\.0\.0\.1|stack/i);
    });
  });
});
