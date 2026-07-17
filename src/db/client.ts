import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import type { Env } from '../config/env.js';
import * as schema from './schema.js';
import {
  checkDatabaseConnection,
  checkDatabaseReadiness,
  closePool,
  type DatabaseConnectionStatus,
} from './lifecycle.js';
import { checkMigrationLedger, type MigrationLedgerResult } from './migration-ledger.js';

export type Database = {
  readonly pool: Pool;
  readonly db: NodePgDatabase<typeof schema>;
  checkReadiness: () => Promise<boolean>;
  checkConnection: () => Promise<DatabaseConnectionStatus>;
  checkMigrations: () => Promise<MigrationLedgerResult>;
  close: () => Promise<void>;
};

export type CreateDatabaseOptions = {
  connectionString: string;
  poolMax: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  readinessTimeoutMs?: number;
};

export function createDatabaseFromEnv(env: Env): Database {
  return createDatabase({
    connectionString: env.DATABASE_URL,
    poolMax: env.DB_POOL_MAX,
    connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
    readinessTimeoutMs: env.READINESS_TIMEOUT_MS,
  });
}

export function createDatabase(options: CreateDatabaseOptions): Database {
  const poolConfig: PoolConfig = {
    connectionString: options.connectionString,
    max: options.poolMax,
    connectionTimeoutMillis: options.connectionTimeoutMs,
    idleTimeoutMillis: options.idleTimeoutMs,
  };

  const pool = new Pool(poolConfig);
  const db = drizzle(pool, { schema });
  const readinessTimeoutMs = options.readinessTimeoutMs ?? options.connectionTimeoutMs;

  let closed = false;

  return {
    pool,
    db,
    checkReadiness: async () =>
      checkDatabaseReadiness(pool, {
        timeoutMs: readinessTimeoutMs,
      }),
    checkConnection: async () =>
      checkDatabaseConnection(pool, {
        timeoutMs: readinessTimeoutMs,
      }),
    checkMigrations: async () =>
      checkMigrationLedger(pool, {
        timeoutMs: readinessTimeoutMs,
      }),
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await closePool(pool);
    },
  };
}
