import { count } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import * as schema from './schema.js';
import { communities, signals } from './schema.js';
import { FOUNDATION_COMMUNITIES, FOUNDATION_SIGNALS } from './seeds/foundation-content.js';
import { seedFoundationContent } from './seeds/seed-foundation.js';

/**
 * Stable advisory-lock identity for the foundation seed runner.
 * Distinct from the migration lock (`town-api-migrate`) and the
 * staging seed lock (`town-api-staging-seed`).
 */
const ADVISORY_LOCK_KEY = "hashtext('town-api-seed-foundation')";

/**
 * Upserts the canonical foundation communities/signals (fixed IDs, never
 * deletes) against DATABASE_URL. Shared by the local `tsx` runner and the
 * compiled production entrypoint.
 */
export async function runSeedFoundation(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for db:seed:foundation');
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
  });

  let lockClient: PoolClient | undefined;
  let lockAcquired = false;

  try {
    lockClient = await pool.connect();
    await lockClient.query(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`);
    lockAcquired = true;

    const db = drizzle(pool, { schema });
    await seedFoundationContent(db);

    const communityCount = await db.select({ value: count() }).from(communities);
    const signalCount = await db.select({ value: count() }).from(signals);
    process.stdout.write(
      `Foundation seed applied: communities=${String(communityCount[0]?.value ?? 0)} signals=${String(signalCount[0]?.value ?? 0)} expectedCommunities=${String(FOUNDATION_COMMUNITIES.length)} expectedSignals=${String(FOUNDATION_SIGNALS.length)}\n`,
    );
  } finally {
    if (lockClient !== undefined) {
      try {
        if (lockAcquired) {
          await lockClient.query(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
        }
      } catch {
        // Never surface unlock errors as seed failure; the lock is
        // released automatically when the client disconnects.
      }
      lockClient.release();
    }
    await pool.end();
  }
}

export function runSeedFoundationCli(): void {
  runSeedFoundation()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Foundation seed failed';
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
