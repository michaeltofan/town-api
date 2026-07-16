import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createDatabase } from '../../src/db/client.js';
import { loadEnv } from '../../src/config/env.js';
import { seedFoundationContent } from '../../src/db/seeds/seed-foundation.js';
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

export async function createSeededTestApp(): Promise<{
  app: AppInstance;
  pool: Pool;
}> {
  const databaseUrl = requireDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  await resetMigrateAndSeed(pool);

  const env = loadEnv({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl,
    DB_POOL_MAX: '5',
    DB_CONNECTION_TIMEOUT_MS: '3000',
    DB_IDLE_TIMEOUT_MS: '1000',
  });

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
