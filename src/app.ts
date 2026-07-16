import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import type { Env } from './config/env.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import openApiPlugin from './plugins/openapi.js';
import { healthRoutes } from './routes/health.js';

export type BuildAppOptions = {
  env: Env;
  logger?: boolean | { level: Env['LOG_LEVEL'] };
};

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: options.logger ?? { level: options.env.LOG_LEVEL },
    requestIdHeader: 'x-request-id',
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      if (typeof header === 'string' && header.length > 0) {
        return header;
      }
      return `req_${crypto.randomUUID()}`;
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(errorHandlerPlugin);
  await app.register(openApiPlugin);
  await app.register(healthRoutes);

  return app;
}

export type AppInstance = Awaited<ReturnType<typeof buildApp>>;
