import type { Pool, PoolClient } from 'pg';

export type ReadinessCheckOptions = {
  timeoutMs: number;
};

/**
 * Runs a bounded readiness probe against PostgreSQL.
 * Returns true when SELECT 1 succeeds within the timeout.
 * Never throws connection details to callers.
 */
export async function checkDatabaseReadiness(
  pool: Pool,
  options: ReadinessCheckOptions,
): Promise<boolean> {
  let client: PoolClient | undefined;
  let timeoutId: NodeJS.Timeout | undefined;

  try {
    const connectPromise = pool.connect();
    const timeoutPromise = new Promise<PoolClient>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('DATABASE_READINESS_TIMEOUT'));
      }, options.timeoutMs);
    });

    client = await Promise.race([connectPromise, timeoutPromise]);

    const queryPromise = client.query('SELECT 1');
    const queryTimeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('DATABASE_READINESS_TIMEOUT'));
      }, options.timeoutMs);
    });

    await Promise.race([queryPromise, queryTimeoutPromise]);
    return true;
  } catch {
    return false;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (client) {
      client.release();
    }
  }
}

export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
}
