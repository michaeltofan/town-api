import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { runSmoke } from '../src/ops/smoke-runner.js';
import { EXPECTED_MIGRATION_COUNT } from '../src/db/migration-ledger.js';
import {
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  CORS_MAX_AGE_SECONDS,
} from '../src/ops/cors-origins.js';

type FakeState = {
  ready: 'ready' | 'not_ready';
  buildCommit: string;
  buildEnvironment: string;
  webhookMounted: boolean;
  membershipStatus: number;
  allowedOrigin?: string;
};

async function buildFakeApp(state: FakeState): Promise<{
  app: FastifyInstance;
  fetchImpl: typeof fetch;
  baseUrl: string;
}> {
  const app = Fastify({ logger: false });
  const allowed = new Set(state.allowedOrigin !== undefined ? [state.allowedOrigin] : []);

  await app.register(cors, {
    credentials: true,
    methods: [...CORS_ALLOWED_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    maxAge: CORS_MAX_AGE_SECONDS,
    strictPreflight: true,
    origin: (requestOrigin, callback) => {
      if (requestOrigin === undefined || requestOrigin === '') {
        callback(null, false);
        return;
      }
      if (requestOrigin === 'null' || !allowed.has(requestOrigin)) {
        callback(null, false);
        return;
      }
      callback(null, true);
    },
  });

  app.get('/health/live', () => ({ status: 'ok' }));
  app.get('/health/ready', (_req, reply) => {
    const isReady = state.ready === 'ready';
    return reply.status(isReady ? 200 : 503).send({
      status: state.ready,
      checks: {
        config: 'ok',
        database: isReady ? 'ok' : 'timeout',
        migrations: isReady ? 'ok' : 'unknown',
      },
    });
  });
  app.get('/health/build', () => ({
    data: {
      service: 'town-api',
      version: '9.9.9',
      commitSha: state.buildCommit,
      environment: state.buildEnvironment,
      nodeVersion: process.version,
      buildTimestamp: null,
      expectedMigrationCount: EXPECTED_MIGRATION_COUNT,
    },
  }));
  app.get('/v1/account/membership', (_req, reply) =>
    reply.status(state.membershipStatus).send({ error: 'unauthenticated' }),
  );
  if (state.webhookMounted) {
    app.post('/v1/billing/webhooks/stripe', (_req, reply) =>
      reply.status(400).send({ error: 'invalid signature' }),
    );
  }

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('failed to bind test server');
  }
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  return { app, fetchImpl: fetch, baseUrl };
}

describe('runSmoke', () => {
  it('passes when everything is healthy including CORS positives', async () => {
    const authorizedOrigin = 'https://staging.towncivic.org';
    const { app, fetchImpl, baseUrl } = await buildFakeApp({
      ready: 'ready',
      buildCommit: 'abc',
      buildEnvironment: 'staging',
      webhookMounted: true,
      membershipStatus: 401,
      allowedOrigin: authorizedOrigin,
    });
    try {
      const result = await runSmoke({
        baseUrl,
        environment: 'staging',
        expectCommitSha: 'abc',
        timeoutMs: 5000,
        unauthorizedOrigin: 'https://evil.example',
        authorizedOrigin,
        fetchImpl,
      });
      expect(result.ok).toBe(true);
      const failed = result.checks.filter((c) => c.status === 'failed');
      expect(failed).toEqual([]);
      expect(result.checks.find((c) => c.name === 'cors-authorized-origin')?.status).toBe('passed');
      expect(result.checks.find((c) => c.name === 'cors-preflight')?.status).toBe('passed');
      expect(result.checks.find((c) => c.name === 'cors-null-origin')?.status).toBe('passed');
      expect(result.checks.find((c) => c.name === 'cors-no-origin')?.status).toBe('passed');
      expect(result.checks.find((c) => c.name === 'cors-unauthorized-origin')?.status).toBe(
        'passed',
      );
    } finally {
      await app.close();
    }
  });

  it('fails when environment mismatches', async () => {
    const { app, fetchImpl, baseUrl } = await buildFakeApp({
      ready: 'ready',
      buildCommit: 'abc',
      buildEnvironment: 'production',
      webhookMounted: true,
      membershipStatus: 401,
    });
    try {
      const result = await runSmoke({
        baseUrl,
        environment: 'staging',
        fetchImpl,
      });
      expect(result.ok).toBe(false);
      const buildCheck = result.checks.find((c) => c.name === 'health-build');
      expect(buildCheck?.status).toBe('failed');
    } finally {
      await app.close();
    }
  });

  it('fails when commit sha does not match --expect-commit', async () => {
    const { app, fetchImpl, baseUrl } = await buildFakeApp({
      ready: 'ready',
      buildCommit: 'abc',
      buildEnvironment: 'staging',
      webhookMounted: true,
      membershipStatus: 401,
    });
    try {
      const result = await runSmoke({
        baseUrl,
        environment: 'staging',
        expectCommitSha: 'def',
        fetchImpl,
      });
      expect(result.ok).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('fails when readiness reports not_ready', async () => {
    const { app, fetchImpl, baseUrl } = await buildFakeApp({
      ready: 'not_ready',
      buildCommit: 'abc',
      buildEnvironment: 'staging',
      webhookMounted: true,
      membershipStatus: 401,
    });
    try {
      const result = await runSmoke({ baseUrl, environment: 'staging', fetchImpl });
      expect(result.ok).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('fails when the unauthenticated route does not return 401', async () => {
    const { app, fetchImpl, baseUrl } = await buildFakeApp({
      ready: 'ready',
      buildCommit: 'abc',
      buildEnvironment: 'staging',
      webhookMounted: true,
      membershipStatus: 200,
    });
    try {
      const result = await runSmoke({ baseUrl, environment: 'staging', fetchImpl });
      const check = result.checks.find((c) => c.name === 'unauthorized-route');
      expect(check?.status).toBe('failed');
      expect(result.ok).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('rejects non-https base URLs unless targeting loopback', async () => {
    const result = await runSmoke({
      baseUrl: 'http://public.example',
      environment: 'staging',
      fetchImpl: () => Promise.reject(new Error('should not be called')),
    });
    expect(result.ok).toBe(false);
    const transport = result.checks.find((c) => c.name === 'transport');
    expect(transport?.status).toBe('failed');
  });

  it('skips optional CORS origin checks when origins are not provided', async () => {
    const { app, fetchImpl, baseUrl } = await buildFakeApp({
      ready: 'ready',
      buildCommit: 'abc',
      buildEnvironment: 'staging',
      webhookMounted: true,
      membershipStatus: 401,
    });
    try {
      const result = await runSmoke({ baseUrl, environment: 'staging', fetchImpl });
      expect(result.checks.find((c) => c.name === 'cors-unauthorized-origin')?.status).toBe(
        'skipped',
      );
      expect(result.checks.find((c) => c.name === 'cors-authorized-origin')?.status).toBe(
        'skipped',
      );
      expect(result.checks.find((c) => c.name === 'cors-preflight')?.status).toBe('skipped');
      expect(result.checks.find((c) => c.name === 'cors-null-origin')?.status).toBe('passed');
      expect(result.checks.find((c) => c.name === 'cors-no-origin')?.status).toBe('passed');
    } finally {
      await app.close();
    }
  });

  it('marks the webhook check as skipped when not mounted', async () => {
    const { app, fetchImpl, baseUrl } = await buildFakeApp({
      ready: 'ready',
      buildCommit: 'abc',
      buildEnvironment: 'staging',
      webhookMounted: false,
      membershipStatus: 401,
    });
    try {
      const result = await runSmoke({ baseUrl, environment: 'staging', fetchImpl });
      const webhook = result.checks.find((c) => c.name === 'stripe-webhook-invalid-signature');
      expect(webhook?.detail).toContain('webhook-not-mounted');
    } finally {
      await app.close();
    }
  });
});
