import type { Pool, PoolClient } from 'pg';

export type ReadinessCheckOptions = {
  timeoutMs: number;
};

export type DatabaseConnectionStatus = 'ok' | 'fail' | 'timeout';

/**
 * Runs a bounded connectivity probe against PostgreSQL.
 * Returns 'ok' when SELECT 1 succeeds within the timeout, 'timeout' when the
 * timeout fires first, and 'fail' for any other error. Never surfaces
 * connection details, SQL, or error strings to callers.
 */
export async function checkDatabaseConnection(
  pool: Pool,
  options: ReadinessCheckOptions,
): Promise<DatabaseConnectionStatus> {
  let client: PoolClient | undefined;
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutState: { timedOut: boolean } = { timedOut: false };

  try {
    const connectPromise = pool.connect();
    const connectTimeoutPromise = new Promise<PoolClient>((_, reject) => {
      timeoutId = setTimeout(() => {
        timeoutState.timedOut = true;
        reject(new Error('DATABASE_READINESS_TIMEOUT'));
      }, options.timeoutMs);
    });

    client = await Promise.race([connectPromise, connectTimeoutPromise]);
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }

    const queryPromise = client.query('SELECT 1');
    const queryTimeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timeoutState.timedOut = true;
        reject(new Error('DATABASE_READINESS_TIMEOUT'));
      }, options.timeoutMs);
    });

    await Promise.race([queryPromise, queryTimeoutPromise]);
    return 'ok';
  } catch {
    return timeoutState.timedOut ? 'timeout' : 'fail';
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (client) {
      client.release();
    }
  }
}

/**
 * Boolean convenience wrapper preserved for existing call sites and fake
 * database test helpers. Returns true when `checkDatabaseConnection` resolves
 * to `'ok'`.
 */
export async function checkDatabaseReadiness(
  pool: Pool,
  options: ReadinessCheckOptions,
): Promise<boolean> {
  return (await checkDatabaseConnection(pool, options)) === 'ok';
}

export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
}
