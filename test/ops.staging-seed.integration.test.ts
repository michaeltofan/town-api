import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDatabase } from '../src/db/client.js';
import {
  StagingSeedError,
  runStagingSeed,
  type StagingSeedResult,
} from '../src/db/run-staging-seed.js';
import { actors, communities, signalConfirmations, signals } from '../src/db/schema.js';
import { CONTROLLED_TEST_ACTOR_ID } from '../src/db/seeds/controlled-actor-content.js';
import {
  FOUNDATION_COMMUNITIES,
  FOUNDATION_COMMUNITY_IDS,
  FOUNDATION_SIGNALS,
  FOUNDATION_SIGNAL_IDS,
} from '../src/db/seeds/foundation-content.js';
import { seedControlledActor } from '../src/db/seeds/seed-controlled-actor.js';
import { seedFoundationContent } from '../src/db/seeds/seed-foundation.js';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

const PRIOR_CANONICAL_COMMUNITIES = FOUNDATION_COMMUNITIES.filter(
  (row) => row.id !== FOUNDATION_COMMUNITY_IDS.aradRo,
);
const PRIOR_CANONICAL_SIGNALS = FOUNDATION_SIGNALS.filter(
  (row) => row.communityId !== FOUNDATION_COMMUNITY_IDS.aradRo,
);

describe('staging seed runner integration', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  const stagingEnv = {
    APP_ENV: 'staging',
    DATABASE_URL: databaseUrl,
  };

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
  });

  beforeEach(async () => {
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function readCounts(): Promise<StagingSeedResult['counts']> {
    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    try {
      const [communityCount, signalCount, actorCount, controlledCount, confirmationCount] =
        await Promise.all([
          database.db.select({ value: count() }).from(communities),
          database.db.select({ value: count() }).from(signals),
          database.db.select({ value: count() }).from(actors),
          database.db
            .select({ value: count() })
            .from(actors)
            .where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID)),
          database.db.select({ value: count() }).from(signalConfirmations),
        ]);
      return {
        communities: communityCount[0]?.value ?? 0,
        signals: signalCount[0]?.value ?? 0,
        actors: actorCount[0]?.value ?? 0,
        controlledActors: controlledCount[0]?.value ?? 0,
        confirmations: confirmationCount[0]?.value ?? 0,
      };
    } finally {
      await database.close();
    }
  }

  it('seeds an empty migrated database to the exact canonical baseline', async () => {
    const result = await runStagingSeed({ env: stagingEnv });
    expect(result.outcome).toBe('seeded');
    expect(result.counts).toEqual({
      communities: 3,
      signals: 9,
      actors: 1,
      controlledActors: 1,
      confirmations: 0,
    });

    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    try {
      const communityRows = await database.db.select().from(communities);
      const signalRows = await database.db.select().from(signals);
      const actorRows = await database.db.select().from(actors);
      expect(communityRows).toHaveLength(3);
      expect(signalRows).toHaveLength(9);
      expect(actorRows).toHaveLength(1);
      expect(actorRows[0]).toMatchObject({
        id: CONTROLLED_TEST_ACTOR_ID,
        accountId: null,
        communityId: FOUNDATION_COMMUNITY_IDS.milanoIt,
        kind: 'controlled_test',
      });
      expect(communityRows.map((row) => row.id).sort()).toEqual(
        FOUNDATION_COMMUNITIES.map((row) => row.id).sort(),
      );
      expect(signalRows.map((row) => row.id).sort()).toEqual(
        Object.values(FOUNDATION_SIGNAL_IDS).sort(),
      );
    } finally {
      await database.close();
    }
  });

  it('reruns safely on an exact canonical database without duplicates or drift', async () => {
    const first = await runStagingSeed({ env: stagingEnv });
    expect(first.outcome).toBe('seeded');

    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    try {
      const beforeCommunities = await database.db.select().from(communities);
      const beforeSignals = await database.db.select().from(signals);
      const beforeActors = await database.db.select().from(actors);

      const second = await runStagingSeed({ env: stagingEnv });
      expect(second.outcome).toBe('already_canonical');
      expect(second.counts).toEqual(first.counts);

      const afterCommunities = await database.db.select().from(communities);
      const afterSignals = await database.db.select().from(signals);
      const afterActors = await database.db.select().from(actors);
      expect(afterCommunities).toEqual(beforeCommunities);
      expect(afterSignals).toEqual(beforeSignals);
      expect(afterActors).toEqual(beforeActors);
      expect(afterCommunities).toHaveLength(3);
      expect(afterSignals).toHaveLength(9);
      expect(afterActors).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it('refuses partial canonical state before mutation', async () => {
    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    try {
      await database.db.insert(communities).values({
        ...FOUNDATION_COMMUNITIES[0],
      });
    } finally {
      await database.close();
    }

    await expect(runStagingSeed({ env: stagingEnv })).rejects.toMatchObject({
      code: 'PREFLIGHT_PARTIAL_CANONICAL',
    } satisfies Partial<StagingSeedError>);

    expect(await readCounts()).toEqual({
      communities: 1,
      signals: 0,
      actors: 0,
      controlledActors: 0,
      confirmations: 0,
    });
  });

  it('reconciles text-only content drift on an otherwise canonical identity set', async () => {
    await runStagingSeed({ env: stagingEnv });
    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    try {
      await database.db
        .update(signals)
        .set({ latestUpdate: 'Stale prototype wording that must be reconciled' })
        .where(eq(signals.id, FOUNDATION_SIGNAL_IDS.milanoSignal1));

      const drifted = await database.db
        .select()
        .from(signals)
        .where(eq(signals.id, FOUNDATION_SIGNAL_IDS.milanoSignal1));
      expect(drifted[0]?.latestUpdate).toBe('Stale prototype wording that must be reconciled');
    } finally {
      await database.close();
    }

    const result = await runStagingSeed({ env: stagingEnv });
    expect(result.outcome).toBe('reconciled');
    expect(result.counts).toEqual({
      communities: 3,
      signals: 9,
      actors: 1,
      controlledActors: 1,
      confirmations: 0,
    });

    const verify = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    try {
      const row = await verify.db
        .select()
        .from(signals)
        .where(eq(signals.id, FOUNDATION_SIGNAL_IDS.milanoSignal1));
      const expected = FOUNDATION_SIGNALS.find(
        (signal) => signal.id === FOUNDATION_SIGNAL_IDS.milanoSignal1,
      );
      expect(row[0]?.latestUpdate).toBe(expected?.latestUpdate);
      expect(row[0]?.latestUpdate).not.toMatch(/prototip|Prototyp/i);
    } finally {
      await verify.close();
    }
  });

  it('refuses conflicting canonical identity when exact totals hide non-canonical IDs', async () => {
    await runStagingSeed({ env: stagingEnv });
    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    try {
      // Replace one canonical signal id while keeping total count at 9.
      await database.pool.query(`DELETE FROM town.signals WHERE id = $1`, [
        FOUNDATION_SIGNAL_IDS.milanoSignal1,
      ]);
      await database.pool.query(
        `INSERT INTO town.signals (
           id, community_id, slug, position, locale, category, area, headline, summary,
           description, why_it_matters, who_is_affected, latest_update, status_label, status_note,
           observed_label, observed_on, observed_precision, author_display_name, image_key,
           image_focus_x, image_focus_y, publication_status, published_at, created_at, updated_at
         )
         SELECT
           '00000000-0000-4000-8000-000000000199', community_id, 'non-canonical-signal', 99,
           locale, category, area, headline, summary, description, why_it_matters, who_is_affected,
           latest_update, status_label, status_note, observed_label, observed_on, observed_precision,
           author_display_name, image_key, image_focus_x, image_focus_y, publication_status,
           published_at, created_at, updated_at
         FROM town.signals
         WHERE id = $1`,
        [FOUNDATION_SIGNAL_IDS.milanoSignal2],
      );
    } finally {
      await database.close();
    }

    await expect(runStagingSeed({ env: stagingEnv })).rejects.toMatchObject({
      code: 'PREFLIGHT_CONFLICTING_CANONICAL',
    });
  });

  it('refuses a controlled actor row with non-null account_id', async () => {
    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    try {
      await seedFoundationContent(database.db);
      const accountId = '12000000-0000-4000-8000-000000000099';
      await database.pool.query(
        `INSERT INTO town.accounts (id, status, created_at, updated_at)
         VALUES ($1, 'pending_email', '2026-07-15T08:00:00.000Z', '2026-07-15T08:00:00.000Z')`,
        [accountId],
      );
      await database.pool.query(
        `INSERT INTO town.actors
           (id, kind, status, display_label, community_id, account_id, created_at, updated_at)
         VALUES
           ($1, 'civic', 'active', 'Linked civic actor', $2, $3,
            '2026-07-15T08:00:00.000Z', '2026-07-15T08:00:00.000Z')`,
        [CONTROLLED_TEST_ACTOR_ID, FOUNDATION_COMMUNITY_IDS.milanoIt, accountId],
      );
    } finally {
      await database.close();
    }

    await expect(runStagingSeed({ env: stagingEnv })).rejects.toMatchObject({
      code: 'PREFLIGHT_CONTROLLED_ACTOR_LINKED',
    });
  });

  it('refuses when any signal confirmation exists', async () => {
    await runStagingSeed({ env: stagingEnv });
    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    try {
      await database.db.insert(signalConfirmations).values({
        id: '00000000-0000-4000-8000-000000000501',
        signalId: FOUNDATION_SIGNAL_IDS.milanoSignal1,
        actorId: CONTROLLED_TEST_ACTOR_ID,
        confirmedAt: '2026-07-15T09:00:00.000Z',
        createdAt: '2026-07-15T09:00:00.000Z',
      });
    } finally {
      await database.close();
    }

    await expect(runStagingSeed({ env: stagingEnv })).rejects.toMatchObject({
      code: 'PREFLIGHT_CONFIRMATIONS_PRESENT',
    });
  });

  it('rolls back the complete operation when mutation fails inside the transaction', async () => {
    await expect(
      runStagingSeed({
        env: stagingEnv,
        injectFailureAfterMutation: true,
      }),
    ).rejects.toMatchObject({ code: 'INJECTED_FAILURE' });

    expect(await readCounts()).toEqual({
      communities: 0,
      signals: 0,
      actors: 0,
      controlledActors: 0,
      confirmations: 0,
    });
  });

  it('fails safely when another seed execution holds the advisory lock', async () => {
    const lockClient = await pool.connect();
    try {
      await lockClient.query(`SELECT pg_advisory_lock(hashtext('town-api-staging-seed'))`);
      await expect(runStagingSeed({ env: stagingEnv })).rejects.toMatchObject({
        code: 'LOCK_HELD',
      });
      expect(await readCounts()).toEqual({
        communities: 0,
        signals: 0,
        actors: 0,
        controlledActors: 0,
        confirmations: 0,
      });
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtext('town-api-staging-seed'))`);
      lockClient.release();
    }
  });

  it('closes pool resources after failure and leaves no open clients', async () => {
    const before = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = current_database()`,
    );
    await expect(
      runStagingSeed({
        env: { APP_ENV: 'staging', DATABASE_URL: databaseUrl },
        injectFailureAfterMutation: true,
      }),
    ).rejects.toMatchObject({ code: 'INJECTED_FAILURE' });

    // Allow brief cleanup; the runner must have ended its pool.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = current_database()`,
    );
    expect(Number(after.rows[0]?.count)).toBeLessThanOrEqual(Number(before.rows[0]?.count) + 1);
  });

  it('refuses unexpected non-canonical communities that block exact invariants', async () => {
    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    try {
      await database.db.insert(communities).values({
        id: '00000000-0000-4000-8000-000000000099',
        slug: 'other-city',
        position: 9,
        countryCode: 'XX',
        cityName: 'Other',
        displayName: 'Other',
        defaultLocale: 'en-US',
        timezone: 'UTC',
        status: 'active',
        createdAt: '2026-07-01T08:00:00.000Z',
        updatedAt: '2026-07-01T08:00:00.000Z',
      });
    } finally {
      await database.close();
    }

    await expect(runStagingSeed({ env: stagingEnv })).rejects.toMatchObject({
      code: 'PREFLIGHT_UNEXPECTED_ROWS',
    });
  });

  it('uses only the canonical foundation signal set after a successful seed', async () => {
    await runStagingSeed({ env: stagingEnv });
    expect(FOUNDATION_SIGNALS).toHaveLength(9);
    expect(FOUNDATION_COMMUNITIES).toHaveLength(3);
    const counts = await readCounts();
    expect(counts.confirmations).toBe(0);
    expect(counts.controlledActors).toBe(1);
  });

  async function seedPriorExactCanonicalSubset(): Promise<void> {
    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    try {
      expect(PRIOR_CANONICAL_COMMUNITIES).toHaveLength(2);
      expect(PRIOR_CANONICAL_SIGNALS).toHaveLength(6);
      for (const community of PRIOR_CANONICAL_COMMUNITIES) {
        await database.db.insert(communities).values({ ...community });
      }
      for (const signal of PRIOR_CANONICAL_SIGNALS) {
        await database.db.insert(signals).values({ ...signal });
      }
      await seedControlledActor(database.db);
    } finally {
      await database.close();
    }
  }

  it('completes an exact prior-canonical subset by inserting only missing manifest rows', async () => {
    await seedPriorExactCanonicalSubset();
    expect(await readCounts()).toEqual({
      communities: 2,
      signals: 6,
      actors: 1,
      controlledActors: 1,
      confirmations: 0,
    });

    const result = await runStagingSeed({ env: stagingEnv });
    expect(result.outcome).toBe('completed_subset');
    expect(result.counts).toEqual({
      communities: 3,
      signals: 9,
      actors: 1,
      controlledActors: 1,
      confirmations: 0,
    });

    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    try {
      const communityRows = await database.db.select().from(communities);
      const signalRows = await database.db.select().from(signals);
      expect(communityRows.map((row) => row.id).sort()).toEqual(
        FOUNDATION_COMMUNITIES.map((row) => row.id).sort(),
      );
      expect(signalRows.map((row) => row.id).sort()).toEqual(
        Object.values(FOUNDATION_SIGNAL_IDS).sort(),
      );
      const arad = communityRows.find((row) => row.id === FOUNDATION_COMMUNITY_IDS.aradRo);
      expect(arad).toMatchObject({
        slug: 'arad-ro',
        defaultLocale: 'ro-RO',
        timezone: 'Europe/Bucharest',
      });
      const aradSignals = signalRows.filter(
        (row) => row.communityId === FOUNDATION_COMMUNITY_IDS.aradRo,
      );
      expect(aradSignals).toHaveLength(3);
      expect(aradSignals.every((row) => row.locale === 'ro-RO')).toBe(true);
    } finally {
      await database.close();
    }
  });

  it('refuses a prior-canonical subset when a present row has drifted content', async () => {
    await seedPriorExactCanonicalSubset();
    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    try {
      await database.db
        .update(signals)
        .set({ latestUpdate: 'Drifted prior-canonical wording must block subset completion' })
        .where(eq(signals.id, FOUNDATION_SIGNAL_IDS.milanoSignal1));
    } finally {
      await database.close();
    }

    await expect(runStagingSeed({ env: stagingEnv })).rejects.toMatchObject({
      code: 'PREFLIGHT_PARTIAL_CANONICAL',
    } satisfies Partial<StagingSeedError>);

    expect(await readCounts()).toEqual({
      communities: 2,
      signals: 6,
      actors: 1,
      controlledActors: 1,
      confirmations: 0,
    });

    const verify = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    try {
      const arad = await verify.db
        .select()
        .from(communities)
        .where(eq(communities.id, FOUNDATION_COMMUNITY_IDS.aradRo));
      expect(arad).toHaveLength(0);
      const drifted = await verify.db
        .select()
        .from(signals)
        .where(eq(signals.id, FOUNDATION_SIGNAL_IDS.milanoSignal1));
      expect(drifted[0]?.latestUpdate).toBe(
        'Drifted prior-canonical wording must block subset completion',
      );
    } finally {
      await verify.close();
    }
  });

  it('reruns as already_canonical after completing a prior-canonical subset', async () => {
    await seedPriorExactCanonicalSubset();
    const first = await runStagingSeed({ env: stagingEnv });
    expect(first.outcome).toBe('completed_subset');
    expect(first.counts.communities).toBe(3);
    expect(first.counts.signals).toBe(9);

    const second = await runStagingSeed({ env: stagingEnv });
    expect(second.outcome).toBe('already_canonical');
    expect(second.counts).toEqual(first.counts);
  });
});
