import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

describe('health endpoints', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '3000',
      LOG_LEVEL: 'silent',
    });

    app = await buildApp({
      env,
      logger: false,
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns liveness payload', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);

    const body = response.json<{
      status: string;
      service: string;
      timestamp: string;
    }>();

    expect(body).toEqual({
      status: 'ok',
      service: 'town-api',
      timestamp: expect.any(String) as string,
    });
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('GET /ready returns readiness payload', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ready',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      status: string;
      service: string;
      timestamp: string;
    }>();

    expect(body).toEqual({
      status: 'ready',
      service: 'town-api',
      timestamp: expect.any(String) as string,
    });
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('exposes OpenAPI JSON at /docs/json', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs/json',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
    }>();

    expect(body.openapi).toMatch(/^3\./);
    expect(body.info.title).toBe('TOWN API');
    expect(body.info.version).toBe('0.1.0');
    expect(body.paths).toHaveProperty('/health');
    expect(body.paths).toHaveProperty('/ready');
  });
});
