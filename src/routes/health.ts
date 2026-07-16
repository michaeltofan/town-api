import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { LiveResponseSchema, ReadyResponseSchema } from '../schemas/health.js';

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
          'Returns ready when the API process can accept traffic. Foundation scope has no external dependencies.',
        response: {
          200: ReadyResponseSchema,
        },
      },
    },
    () => ({ status: 'ready' as const }),
  );

  done();
};
