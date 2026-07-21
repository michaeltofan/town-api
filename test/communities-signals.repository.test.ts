import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabase } from '../src/db/client.js';
import {
  findActiveCommunityBySlug,
  listActiveCommunities,
} from '../src/db/repositories/communities.js';
import {
  findPublishedSignalById,
  listPublishedSignalsForCommunity,
} from '../src/db/repositories/signals.js';
import {
  FOUNDATION_COMMUNITY_IDS,
  FOUNDATION_SIGNAL_IDS,
} from '../src/db/seeds/foundation-content.js';
import { requireDatabaseUrl, resetMigrateAndSeed } from './helpers/pg.js';

describe('communities and signals repositories', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;
  let database: ReturnType<typeof createDatabase>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetMigrateAndSeed(pool);
    database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it('lists active communities ordered by position', async () => {
    const rows = await listActiveCommunities(database.db);
    expect(rows.map((row) => row.slug)).toEqual(['milano-it', 'munich-de', 'arad-ro']);
    expect(rows.every((row) => row.status === 'active')).toBe(true);
  });

  it('finds community by slug and returns null for missing', async () => {
    const milano = await findActiveCommunityBySlug(database.db, 'milano-it');
    expect(milano?.id).toBe(FOUNDATION_COMMUNITY_IDS.milanoIt);
    await expect(findActiveCommunityBySlug(database.db, 'missing-city')).resolves.toBeNull();
  });

  it('lists published signals ordered by position for a community', async () => {
    const rows = await listPublishedSignalsForCommunity(
      database.db,
      FOUNDATION_COMMUNITY_IDS.munichDe,
    );
    expect(rows.map((row) => row.slug)).toEqual([
      'munich-signal-1',
      'munich-signal-2',
      'munich-signal-3',
    ]);
    expect(rows.every((row) => row.publicationStatus === 'published')).toBe(true);
  });

  it('finds published signal by UUID with community relation', async () => {
    const result = await findPublishedSignalById(database.db, FOUNDATION_SIGNAL_IDS.milanoSignal1);
    expect(result?.signal.slug).toBe('milano-signal-1');
    expect(result?.community).toEqual({
      id: FOUNDATION_COMMUNITY_IDS.milanoIt,
      slug: 'milano-it',
      displayName: 'Milano',
      defaultLocale: 'it-IT',
    });

    await expect(
      findPublishedSignalById(database.db, '00000000-0000-4000-8000-000000009999'),
    ).resolves.toBeNull();
  });
});
