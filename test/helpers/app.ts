import { buildApp, type AppInstance } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';

export async function createTestApp(): Promise<AppInstance> {
  const env = loadEnv({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    LOG_LEVEL: 'silent',
  });

  const app = await buildApp({
    env,
    logger: false,
  });

  await app.ready();
  return app;
}
