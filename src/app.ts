import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import type { Env } from './config/env.js';
import { createDatabaseFromEnv, type Database } from './db/client.js';
import databasePlugin from './db/plugin.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import openApiPlugin from './plugins/openapi.js';
import { communitiesRoutes } from './routes/communities.js';
import { healthRoutes } from './routes/health.js';
import { signalsRoutes } from './routes/signals.js';

export type BuildAppOptions = {
  env: Env;
  logger?: boolean | { level: Env['LOG_LEVEL'] };
  /**
   * Optional injected database dependency for tests.
   * When omitted, a pool is created from validated environment settings.
   */
  database?: Database;
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

  const database = options.database ?? createDatabaseFromEnv(options.env);

  await app.register(errorHandlerPlugin);
  await app.register(openApiPlugin);
  await app.register(databasePlugin, { database });
  await app.register(healthRoutes);
  await app.register(communitiesRoutes);
  await app.register(signalsRoutes);

  return app;
}

export type AppInstance = Awaited<ReturnType<typeof buildApp>>;
