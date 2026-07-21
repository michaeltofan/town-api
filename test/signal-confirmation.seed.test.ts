import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDatabase } from '../src/db/client.js';
import { actors, communities, signalConfirmations, signals } from '../src/db/schema.js';
import { CONTROLLED_TEST_ACTOR_ID } from '../src/db/seeds/controlled-actor-content.js';
import { FOUNDATION_COMMUNITY_IDS } from '../src/db/seeds/foundation-content.js';
import { seedControlledActor } from '../src/db/seeds/seed-controlled-actor.js';
import { requireDatabaseUrl, resetMigrateAndSeed } from './helpers/pg.js';

describe('controlled actor seed', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetMigrateAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('seeds exactly one Milano controlled actor without confirmations and is idempotent', async () => {
    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });

    try {
      const communitiesBefore = await database.db.select({ value: count() }).from(communities);
      const signalsBefore = await database.db.select({ value: count() }).from(signals);

      await seedControlledActor(database.db);
      await seedControlledActor(database.db);

      const actorRows = await database.db.select().from(actors);
      expect(actorRows).toHaveLength(1);
      expect(actorRows[0]).toMatchObject({
        id: CONTROLLED_TEST_ACTOR_ID,
        kind: 'controlled_test',
        status: 'active',
        displayLabel: 'Controlled test actor',
        communityId: FOUNDATION_COMMUNITY_IDS.milanoIt,
      });

      const confirmationCount = await database.db
        .select({ value: count() })
        .from(signalConfirmations);
      expect(confirmationCount[0]?.value).toBe(0);

      const communitiesAfter = await database.db.select({ value: count() }).from(communities);
      const signalsAfter = await database.db.select({ value: count() }).from(signals);
      expect(communitiesAfter[0]?.value).toBe(communitiesBefore[0]?.value);
      expect(signalsAfter[0]?.value).toBe(signalsBefore[0]?.value);
      expect(communitiesAfter[0]?.value).toBe(3);
      expect(signalsAfter[0]?.value).toBe(9);

      await database.db.insert(actors).values({
        id: '00000000-0000-4000-8000-000000000399',
        kind: 'controlled_test',
        status: 'active',
        displayLabel: 'Unknown retained actor',
        communityId: FOUNDATION_COMMUNITY_IDS.munichDe,
        accountId: null,
        createdAt: '2026-07-15T09:00:00.000Z',
        updatedAt: '2026-07-15T09:00:00.000Z',
      });

      await seedControlledActor(database.db);

      const afterUnknown = await database.db.select({ value: count() }).from(actors);
      expect(afterUnknown[0]?.value).toBe(2);
      const unknown = await database.db
        .select()
        .from(actors)
        .where(eq(actors.id, '00000000-0000-4000-8000-000000000399'));
      expect(unknown).toHaveLength(1);
    } finally {
      await database.close();
    }
  });
});
