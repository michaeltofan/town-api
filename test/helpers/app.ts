import { buildApp, type AppInstance } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import { createFakeDatabase } from './database.js';
import { createTestEnv } from './env.js';

export async function createTestApp(options?: {
  database?: Database;
  ready?: boolean;
}): Promise<AppInstance> {
  const env = createTestEnv();
  const database = options?.database ?? createFakeDatabase({ ready: options?.ready ?? true });

  const app = await buildApp({
    env,
    logger: false,
    database,
  });

  await app.ready();
  return app;
}
