import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabase } from '../src/db/client.js';
import {
  FoundationSeedError,
  requireAppEnv,
  runFoundationSeed,
} from '../src/db/run-foundation-seed.js';
import { FOUNDATION_COMMUNITIES, FOUNDATION_SIGNALS } from '../src/db/seeds/foundation-content.js';
import { communities, signals } from '../src/db/schema.js';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

describe('foundation seed environment guard', () => {
  it('refuses when APP_ENV does not match the required value', () => {
    for (const appEnv of [undefined, 'staging', 'development', 'test', 'PRODUCTION']) {
      const env: NodeJS.ProcessEnv = appEnv === undefined ? {} : { APP_ENV: appEnv };
      expect(() => {
        requireAppEnv(env, 'production');
      }).toThrowError(FoundationSeedError);
      try {
        requireAppEnv(env, 'production');
        expect.unreachable('requireAppEnv should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(FoundationSeedError);
        expect((error as FoundationSeedError).code).toBe('APP_ENV_MISMATCH');
      }
    }
  });

  it('does not throw when APP_ENV matches the required value exactly', () => {
    expect(() => {
      requireAppEnv({ APP_ENV: 'production' }, 'production');
    }).not.toThrow();
    expect(() => {
      requireAppEnv({ APP_ENV: 'staging' }, 'staging');
    }).not.toThrow();
  });
});

describe('foundation seed transaction (real PostgreSQL)', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;
  let database: ReturnType<typeof createDatabase>;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetAndMigrate(pool);
    database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
  });

  it('upserts every canonical community and signal in a single transaction', async () => {
    const counts = await runFoundationSeed(database.db);
    expect(counts).toEqual({
      communities: FOUNDATION_COMMUNITIES.length,
      signals: FOUNDATION_SIGNALS.length,
    });

    const communityRows = await database.db.select().from(communities);
    const signalRows = await database.db.select().from(signals);
    expect(communityRows).toHaveLength(FOUNDATION_COMMUNITIES.length);
    expect(signalRows).toHaveLength(FOUNDATION_SIGNALS.length);
    await database.close();
  });

  it('is idempotent: running twice yields the same counts with no duplicate rows', async () => {
    const first = await runFoundationSeed(database.db);
    const second = await runFoundationSeed(database.db);
    expect(second).toEqual(first);

    const communityRows = await database.db.select().from(communities);
    const signalRows = await database.db.select().from(signals);
    expect(communityRows).toHaveLength(FOUNDATION_COMMUNITIES.length);
    expect(signalRows).toHaveLength(FOUNDATION_SIGNALS.length);
    expect(new Set(communityRows.map((row) => row.id)).size).toBe(communityRows.length);
    expect(new Set(signalRows.map((row) => row.id)).size).toBe(signalRows.length);
    await database.close();
  });

  it('is atomic: an injected failure after the upsert leaves no rows behind', async () => {
    await expect(
      runFoundationSeed(database.db, { injectFailureAfterUpsert: true }),
    ).rejects.toMatchObject({ code: 'INJECTED_FAILURE' } satisfies Partial<FoundationSeedError>);

    const communityRows = await database.db.select().from(communities);
    const signalRows = await database.db.select().from(signals);
    expect(communityRows).toHaveLength(0);
    expect(signalRows).toHaveLength(0);
    await database.close();
  });

  it('a failed run does not block a subsequent successful run', async () => {
    await expect(
      runFoundationSeed(database.db, { injectFailureAfterUpsert: true }),
    ).rejects.toThrow();

    const counts = await runFoundationSeed(database.db);
    expect(counts).toEqual({
      communities: FOUNDATION_COMMUNITIES.length,
      signals: FOUNDATION_SIGNALS.length,
    });
    const communityRows = await database.db.select().from(communities);
    expect(communityRows).toHaveLength(FOUNDATION_COMMUNITIES.length);
    await database.close();
  });
});
