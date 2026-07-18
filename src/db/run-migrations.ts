import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';

// Stable bigint key derived from a fixed string that identifies this project's
// migration process. pg_advisory_lock takes a bigint; hashtext returns int4, so
// we combine two hashtext values into a bigint via a portable expression.
const ADVISORY_LOCK_KEY = "hashtext('town-api-migrate')";

function resolveMigrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/db or dist/db → repository / image root → drizzle/
  return path.resolve(here, '..', '..', 'drizzle');
}

/**
 * Apply committed drizzle migrations under a PostgreSQL advisory lock.
 * Shared by the local `tsx` runner and the compiled production entrypoint.
 */
export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for db:migrate');
  }

  const migrationsFolder = resolveMigrationsFolder();

  const pool = new Pool({
    connectionString: databaseUrl,
    // One dedicated client holds the advisory lock while drizzle-kit's
    // migrator uses a second client to apply migrations. Keep the pool as
    // small as reasonable to avoid competing with runtime traffic.
    max: 2,
  });

  let lockAcquired = false;
  let lockClient: PoolClient | undefined;

  try {
    lockClient = await pool.connect();
    await lockClient.query(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`);
    lockAcquired = true;

    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
    process.stdout.write('Migrations applied successfully\n');
  } finally {
    if (lockClient !== undefined) {
      try {
        if (lockAcquired) {
          await lockClient.query(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
        }
      } catch {
        // Never surface unlock errors as migration failure; the lock is
        // released automatically when the client disconnects.
      }
      lockClient.release();
    }
    await pool.end();
  }
}

export function runMigrationsCli(): void {
  runMigrations().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Migration failed';
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
