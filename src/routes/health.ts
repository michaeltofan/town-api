import type { FastifyPluginCallback } from 'fastify';

const healthResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'service', 'timestamp'],
  properties: {
    status: { type: 'string', enum: ['ok'] },
    service: { type: 'string' },
    timestamp: { type: 'string', format: 'date-time' },
  },
} as const;

const readyResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'service', 'timestamp'],
  properties: {
    status: { type: 'string', enum: ['ready'] },
    service: { type: 'string' },
    timestamp: { type: 'string', format: 'date-time' },
  },
} as const;

export const healthRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'Liveness probe',
        description: 'Returns OK when the process is running and able to serve HTTP.',
        response: {
          200: healthResponseSchema,
        },
      },
    },
    () => ({
      status: 'ok' as const,
      service: 'town-api',
      timestamp: new Date().toISOString(),
    }),
  );

  app.get(
    '/ready',
    {
      schema: {
        tags: ['Health'],
        summary: 'Readiness probe',
        description:
          'Returns ready when the API process can accept traffic. Foundation scope has no external dependencies.',
        response: {
          200: readyResponseSchema,
        },
      },
    },
    () => ({
      status: 'ready' as const,
      service: 'town-api',
      timestamp: new Date().toISOString(),
    }),
  );

  done();
};
