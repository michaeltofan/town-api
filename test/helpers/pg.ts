import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createDatabase } from '../../src/db/client.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { seedFoundationContent } from '../../src/db/seeds/seed-foundation.js';
import { seedControlledActor } from '../../src/db/seeds/seed-controlled-actor.js';
import { CONTROLLED_TEST_ACTOR_ID } from '../../src/db/seeds/controlled-actor-content.js';
import { buildApp, type AppInstance } from '../../src/app.js';

export function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error('DATABASE_URL must be set for PostgreSQL integration tests');
  }
  return value;
}

export const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

export const CONTROLLED_TEST_KEY = 'town-controlled-test-key-local-only';

export async function resetAndMigrate(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS town CASCADE');
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder });
}

export async function resetMigrateAndSeed(pool: Pool): Promise<void> {
  await resetAndMigrate(pool);
  const database = createDatabase({
    connectionString: requireDatabaseUrl(),
    poolMax: 2,
    connectionTimeoutMs: 3000,
    idleTimeoutMs: 1000,
  });

  try {
    await seedFoundationContent(database.db);
  } finally {
    await database.close();
  }
}

export async function resetMigrateSeedFoundationAndActor(pool: Pool): Promise<void> {
  await resetMigrateAndSeed(pool);
  const database = createDatabase({
    connectionString: requireDatabaseUrl(),
    poolMax: 2,
    connectionTimeoutMs: 3000,
    idleTimeoutMs: 1000,
  });

  try {
    await seedControlledActor(database.db);
  } finally {
    await database.close();
  }
}

function createIntegrationEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
  const databaseUrl = requireDatabaseUrl();
  return loadEnv({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl,
    DB_POOL_MAX: '5',
    DB_CONNECTION_TIMEOUT_MS: '3000',
    DB_IDLE_TIMEOUT_MS: '1000',
    CONTROLLED_CONFIRMATION_ENABLED: 'false',
    ...overrides,
  });
}

export async function createSeededTestApp(): Promise<{
  app: AppInstance;
  pool: Pool;
}> {
  const databaseUrl = requireDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  await resetMigrateAndSeed(pool);

  const env = createIntegrationEnv();
  const database = createDatabase({
    connectionString: env.DATABASE_URL,
    poolMax: env.DB_POOL_MAX,
    connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
  });

  const app = await buildApp({
    env,
    logger: false,
    database,
  });
  await app.ready();

  return { app, pool };
}

export async function createControlledConfirmationTestApp(options?: {
  enabled?: boolean;
  key?: string;
  actorId?: string;
  logger?: boolean | Record<string, unknown>;
}): Promise<{
  app: AppInstance;
  pool: Pool;
  env: Env;
  controlKey: string;
}> {
  const databaseUrl = requireDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  await resetMigrateSeedFoundationAndActor(pool);

  const enabled = options?.enabled ?? true;
  const controlKey = options?.key ?? CONTROLLED_TEST_KEY;
  const actorId = options?.actorId ?? CONTROLLED_TEST_ACTOR_ID;

  const env = createIntegrationEnv(
    enabled
      ? {
          CONTROLLED_CONFIRMATION_ENABLED: 'true',
          CONTROLLED_CONFIRMATION_KEY: controlKey,
          CONTROLLED_TEST_ACTOR_ID: actorId,
        }
      : {
          CONTROLLED_CONFIRMATION_ENABLED: 'false',
        },
  );

  const database = createDatabase({
    connectionString: env.DATABASE_URL,
    poolMax: env.DB_POOL_MAX,
    connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
  });

  const app = await buildApp({
    env,
    logger: options?.logger ?? false,
    database,
  });
  await app.ready();

  return { app, pool, env, controlKey };
}
