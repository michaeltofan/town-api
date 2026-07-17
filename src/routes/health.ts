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
          'Returns ready when configuration is accepted, PostgreSQL is reachable within the bounded readiness timeout, and the drizzle migration ledger matches the expected count. Returns not_ready with safe component checks otherwise. Never exposes migration names, SQL, connection strings, or secrets.',
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
        app.log.warn({ event: 'readiness_shutting_down' }, 'readiness reports shutdown');
        return reply.status(503).send({ status: 'not_ready' as const, checks });
      }

      const databaseStatus = await app.database.checkConnection();
      checks.database = databaseStatus;

      if (databaseStatus !== 'ok') {
        checks.migrations = 'unknown';
        app.log.warn(
          { event: 'readiness_database_failed', databaseStatus },
          'readiness database check failed',
        );
        return reply.status(503).send({ status: 'not_ready' as const, checks });
      }

      const migrationResult = await app.database.checkMigrations();
      checks.migrations = migrationResult.status;

      if (migrationResult.status !== 'ok') {
        app.log.warn(
          {
            event: 'readiness_migrations_failed',
            migrationStatus: migrationResult.status,
            expected: migrationResult.expected,
            applied: migrationResult.applied,
          },
          'readiness migration ledger check failed',
        );
        return reply.status(503).send({ status: 'not_ready' as const, checks });
      }

      return reply.status(200).send({ status: 'ready' as const, checks });
    },
  );

  app.get(
    '/health/build',
    {
      schema: {
        tags: ['Health'],
        summary: 'Runtime build identity',
        description:
          'Returns the immutable runtime build identity: service name, semantic version from package.json, deployed commit SHA when present, resolved APP_ENV, Node.js runtime version, optional build timestamp, and the expected drizzle migration count derived from the shipped journal. Never returns secrets, connection strings, hostnames, or request-scoped data.',
        response: {
          200: BuildResponseSchema,
        },
      },
    },
    () => ({ data: identity }),
  );

  done();
};

export const healthRoutes = fp<HealthRoutesOptions>(healthRoutesPlugin, {
  name: 'health-routes',
});

// Re-export the plugin callback type shape for backwards compatibility with
// existing TypeBox-typed route imports elsewhere in the codebase.
export type HealthRoutes = FastifyPluginCallbackTypebox<HealthRoutesOptions>;
