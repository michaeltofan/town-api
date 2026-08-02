import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Env } from '../config/env.js';
import { buildIdentityFromEnv } from '../ops/build-identity.js';
import {
  BuildResponseSchema,
  type HealthChecks,
  LiveResponseSchema,
  NotReadyResponseSchema,
  ReadyResponseSchema,
} from '../schemas/health.js';

export type HealthRoutesOptions = {
  env: Env;
};

const healthRoutesPlugin = (
  app: FastifyInstance,
  options: HealthRoutesOptions,
  done: (error?: Error) => void,
): void => {
  const identity = buildIdentityFromEnv(options.env);

  app.get(
    '/health/live',
    {
      schema: {
        tags: ['Health'],
        summary: 'Liveness probe',
        description: 'Returns ok when the process is running and able to serve HTTP.',
        response: {
          200: LiveResponseSchema,
        },
      },
    },
    () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['Health'],
        summary: 'Readiness probe',
        description:
          'Returns ready when configuration is accepted, PostgreSQL is reachable within the bounded readiness timeout, and the drizzle migration ledger matches the repository-expected ordered hash and timestamp sequence. Public body is status-only; component detail stays in server logs and the authenticated platform status API. Never exposes migration names, hashes, SQL, connection strings, or secrets.',
        response: {
          200: ReadyResponseSchema,
          503: NotReadyResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const checks: HealthChecks = {
        config: 'ok',
        database: 'ok',
        migrations: 'ok',
      };

      if (app.isShuttingDown) {
        checks.database = 'fail';
        checks.migrations = 'unknown';
        app.log.warn({ event: 'readiness_shutting_down', checks }, 'readiness reports shutdown');
        return reply.status(503).send({ status: 'not_ready' as const });
      }

      const databaseStatus = await app.database.checkConnection();
      checks.database = databaseStatus;

      if (databaseStatus !== 'ok') {
        checks.migrations = 'unknown';
        app.log.warn(
          { event: 'readiness_database_failed', databaseStatus, checks },
          'readiness database check failed',
        );
        return reply.status(503).send({ status: 'not_ready' as const });
      }

      const migrationResult = await app.database.checkMigrations();
      checks.migrations = migrationResult.status;

      if (migrationResult.status !== 'ok') {
        app.log.warn(
          {
            event: 'readiness_migrations_failed',
            migrationStatus: migrationResult.status,
            migrationDetail: migrationResult.detail,
            expected: migrationResult.expected,
            applied: migrationResult.applied,
            checks,
          },
          'readiness migration ledger check failed',
        );
        return reply.status(503).send({ status: 'not_ready' as const });
      }

      return reply.status(200).send({ status: 'ready' as const });
    },
  );

  app.get(
    '/health/build',
    {
      schema: {
        tags: ['Health'],
        summary: 'Runtime build identity',
        description:
          'Returns a minimal public build identity: service name, semantic version, resolved deployment commit SHA when present, and APP_ENV. Omits Node.js runtime version, build timestamp, and migration counts (those remain available to authenticated platform operators). Never returns secrets, connection strings, hostnames, raw environment variables, or request-scoped data.',
        response: {
          200: BuildResponseSchema,
        },
      },
    },
    () => ({
      data: {
        service: identity.service,
        version: identity.version,
        commitSha: identity.commitSha,
        environment: identity.environment,
      },
    }),
  );

  done();
};

export const healthRoutes = fp<HealthRoutesOptions>(healthRoutesPlugin, {
  name: 'health-routes',
});

export type HealthRoutes = FastifyPluginCallbackTypebox<HealthRoutesOptions>;
