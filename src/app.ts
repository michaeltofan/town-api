import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import swaggerPlugin from './plugins/swagger.js';
import { healthRoutes } from './routes/health.js';

export type BuildAppOptions = {
  env: Env;
  logger?: boolean | { level: Env['LOG_LEVEL'] };
};

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? { level: options.env.LOG_LEVEL },
  });

  await app.register(swaggerPlugin);
  await app.register(healthRoutes);

  return app;
}
