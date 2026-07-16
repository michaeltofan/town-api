import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppInstance } from '../src/app.js';
import { createTestApp } from './helpers/app.js';

describe('health endpoints', () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live returns exact liveness body', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    const body: unknown = response.json();
    expect(body).toEqual({ status: 'ok' });
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(['status']);
  });

  it('GET /health/ready returns exact readiness body', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    const body: unknown = response.json();
    expect(body).toEqual({ status: 'ready' });
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(['status']);
  });

  it('health responses use JSON content type', async () => {
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(live.headers['content-type']).toMatch(/^application\/json/);
    expect(ready.headers['content-type']).toMatch(/^application\/json/);
  });
});
