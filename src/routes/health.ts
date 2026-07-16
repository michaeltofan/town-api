import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import {
  LiveResponseSchema,
  NotReadyResponseSchema,
  ReadyResponseSchema,
} from '../schemas/health.js';

export const healthRoutes: FastifyPluginCallbackTypebox = (app, _opts, done) => {
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
          'Returns ready when PostgreSQL is reachable. Returns not_ready when the database readiness check fails.',
        response: {
          200: ReadyResponseSchema,
          503: NotReadyResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const isReady = await app.database.checkReadiness();

      if (!isReady) {
        app.log.warn({ code: 'DATABASE_READINESS_FAILED' }, 'Database readiness check failed');
        return reply.status(503).send({ status: 'not_ready' as const });
      }

      return reply.status(200).send({ status: 'ready' as const });
    },
  );

  done();
};
