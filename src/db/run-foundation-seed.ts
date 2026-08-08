import { inArray } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';
import { communities, signals } from './schema.js';
import { FOUNDATION_COMMUNITIES, FOUNDATION_SIGNALS } from './seeds/foundation-content.js';
import { seedFoundationContent } from './seeds/seed-foundation.js';

type Db = NodePgDatabase<typeof schema>;

export type FoundationSeedErrorCode =
  | 'APP_ENV_MISMATCH'
  | 'DATABASE_URL_REQUIRED'
  | 'POSTCHECK_MISSING_CANONICAL_ROWS'
  | 'INJECTED_FAILURE';

export class FoundationSeedError extends Error {
  readonly code: FoundationSeedErrorCode;

  constructor(code: FoundationSeedErrorCode, message: string) {
    super(message);
    this.name = 'FoundationSeedError';
    this.code = code;
  }
}

export type FoundationSeedCounts = {
  readonly communities: number;
  readonly signals: number;
};

const CANONICAL_COMMUNITY_IDS = FOUNDATION_COMMUNITIES.map((row) => row.id);
const CANONICAL_SIGNAL_IDS = FOUNDATION_SIGNALS.map((row) => row.id);

export type RunFoundationSeedOptions = {
  /** Test-only: throw after the upsert but before postcheck, to prove the
   * whole operation rolls back and leaves no partial rows. */
  readonly injectFailureAfterUpsert?: boolean;
};

/**
 * Upserts the canonical foundation dataset in a single transaction, then
 * verifies every canonical community and signal ID is present before
 * returning. A missing row throws and rolls back the entire transaction —
 * the seed either fully lands or has no effect at all.
 */
export async function runFoundationSeed(
  db: Db,
  options: RunFoundationSeedOptions = {},
): Promise<FoundationSeedCounts> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await seedFoundationContent(txDb);

    if (options.injectFailureAfterUpsert === true) {
      throw new FoundationSeedError(
        'INJECTED_FAILURE',
        'Injected failure after upsert (test-only)',
      );
    }

    const communityRows = await txDb
      .select({ id: communities.id })
      .from(communities)
      .where(inArray(communities.id, CANONICAL_COMMUNITY_IDS));
    const signalRows = await txDb
      .select({ id: signals.id })
      .from(signals)
      .where(inArray(signals.id, CANONICAL_SIGNAL_IDS));

    const presentCommunityIds = new Set(communityRows.map((row) => row.id));
    const presentSignalIds = new Set(signalRows.map((row) => row.id));
    const missingCommunityIds = CANONICAL_COMMUNITY_IDS.filter(
      (id) => !presentCommunityIds.has(id),
    );
    const missingSignalIds = CANONICAL_SIGNAL_IDS.filter((id) => !presentSignalIds.has(id));

    if (missingCommunityIds.length > 0 || missingSignalIds.length > 0) {
      throw new FoundationSeedError(
        'POSTCHECK_MISSING_CANONICAL_ROWS',
        `Foundation seed verification failed after upsert: missing ${String(missingCommunityIds.length)} ` +
          `of ${String(CANONICAL_COMMUNITY_IDS.length)} canonical communities and ${String(missingSignalIds.length)} ` +
          `of ${String(CANONICAL_SIGNAL_IDS.length)} canonical signals`,
      );
    }

    return {
      communities: CANONICAL_COMMUNITY_IDS.length,
      signals: CANONICAL_SIGNAL_IDS.length,
    };
  });
}

function requireDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new FoundationSeedError(
      'DATABASE_URL_REQUIRED',
      'DATABASE_URL is required to run the foundation seed',
    );
  }
  return databaseUrl;
}

/**
 * Refuses unless env.APP_ENV matches `required` exactly. Applied only by
 * the compiled production entrypoint (db:seed:foundation:production) — the
 * plain dev/CI entrypoint (db:seed:foundation) intentionally has no
 * environment restriction, since CI runs it under APP_ENV=test.
 */
export function requireAppEnv(env: NodeJS.ProcessEnv, required: string): void {
  if (env.APP_ENV !== required) {
    throw new FoundationSeedError(
      'APP_ENV_MISMATCH',
      `Foundation seed production runner requires APP_ENV=${required} and refuses all ` +
        `other environments (got ${env.APP_ENV ?? 'undefined'})`,
    );
  }
}

function logEvent(
  operation: string,
  stage: 'env_check' | 'mutate' | 'complete' | 'error',
  status: 'ok' | 'fail',
  details: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const payload: Record<string, string | number | boolean | null> = { operation, stage, status };
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined) {
      payload[key] = value;
    }
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export type RunFoundationSeedCliOptions = {
  /** Logged as the "operation" field, e.g. "db:seed:foundation:production". */
  readonly operation: string;
  /** When set, refuses unless env.APP_ENV matches exactly. */
  readonly requireAppEnv?: string;
};

/**
 * Shared CLI entrypoint for both the dev/CI runner
 * (scripts/seed-foundation-content.ts, run via tsx) and the compiled
 * production runner (src/scripts/seed-foundation-content.ts, run via
 * `node dist/scripts/seed-foundation-content.js`) — the only difference
 * between the two is whether `options.requireAppEnv` is set.
 */
export function runFoundationSeedCli(
  env: NodeJS.ProcessEnv = process.env,
  options: RunFoundationSeedCliOptions,
): void {
  void (async () => {
    let pool: Pool | undefined;
    try {
      if (options.requireAppEnv !== undefined) {
        requireAppEnv(env, options.requireAppEnv);
      }
      const databaseUrl = requireDatabaseUrl(env);
      logEvent(options.operation, 'env_check', 'ok', {
        appEnv: options.requireAppEnv ?? env.APP_ENV ?? null,
      });

      pool = new Pool({ connectionString: databaseUrl, max: 2 });
      const db = drizzle(pool, { schema });

      logEvent(options.operation, 'mutate', 'ok', { action: 'seed_foundation_content' });
      const counts = await runFoundationSeed(db);
      logEvent(options.operation, 'complete', 'ok', { ...counts });
      process.stdout.write(
        `Foundation seed applied: communities=${String(counts.communities)} signals=${String(counts.signals)}\n`,
      );
      process.exitCode = 0;
    } catch (error: unknown) {
      const code = error instanceof FoundationSeedError ? error.code : 'UNEXPECTED';
      const message = error instanceof Error ? error.message : `${options.operation} failed`;
      logEvent(options.operation, 'error', 'fail', { code, reason: message });
      process.stderr.write(`${code}: ${message}\n`);
      process.exitCode = 1;
    } finally {
      if (pool !== undefined) {
        await pool.end();
      }
    }
  })();
}
