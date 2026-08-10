import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDatabase } from '../src/db/client.js';
import {
  FOUNDATION_COMMUNITIES,
  FOUNDATION_SIGNALS,
  FOUNDATION_COMMUNITY_IDS,
  FOUNDATION_SIGNAL_IDS,
  type CanonicalCommunity,
  type CanonicalSignal,
} from '../src/db/seeds/foundation-content.js';
import { seedFoundationContent } from '../src/db/seeds/seed-foundation.js';
import { communities, signals, type CommunityRow, type SignalRow } from '../src/db/schema.js';
import { toIsoTimestamp } from '../src/lib/timestamps.js';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

function normalizeCommunity(row: CommunityRow): CanonicalCommunity {
  return {
    ...row,
    status: 'active',
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

function normalizeSignal(row: SignalRow): CanonicalSignal {
  return {
    id: row.id,
    communityId: row.communityId,
    slug: row.slug,
    position: row.position,
    locale: row.locale,
    category: row.category,
    area: row.area,
    headline: row.headline,
    summary: row.summary,
    description: row.description,
    whyItMatters: row.whyItMatters,
    whoIsAffected: row.whoIsAffected,
    latestUpdate: row.latestUpdate,
    statusLabel: row.statusLabel,
    statusNote: row.statusNote,
    observedLabel: row.observedLabel,
    observedOn: row.observedOn,
    observedPrecision: row.observedPrecision as 'day' | 'week',
    authorDisplayName: row.authorDisplayName,
    imageKey: row.imageKey,
    imageFocusX: row.imageFocusX,
    imageFocusY: row.imageFocusY,
    publicationStatus: 'published',
    publishedAt: toIsoTimestamp(row.publishedAt),
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

describe('foundation seed', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;
  let database: ReturnType<typeof createDatabase>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
    database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 2,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    await seedFoundationContent(database.db);
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it('seeds exactly 7 communities and 21 signals with stable IDs/slugs/locales', async () => {
    const communityRows = await database.db.select().from(communities);
    const signalRows = await database.db.select().from(signals);

    expect(communityRows).toHaveLength(22);
    expect(signalRows).toHaveLength(66);

    expect(communityRows.map((row) => row.id).sort()).toEqual(
      Object.values(FOUNDATION_COMMUNITY_IDS).sort(),
    );
    expect(signalRows.map((row) => row.id).sort()).toEqual(
      Object.values(FOUNDATION_SIGNAL_IDS).sort(),
    );

    const milanoSignals = signalRows
      .filter((row) => row.communityId === FOUNDATION_COMMUNITY_IDS.milanoIt)
      .sort((a, b) => a.position - b.position);
    const munichSignals = signalRows
      .filter((row) => row.communityId === FOUNDATION_COMMUNITY_IDS.munichDe)
      .sort((a, b) => a.position - b.position);
    const aradSignals = signalRows
      .filter((row) => row.communityId === FOUNDATION_COMMUNITY_IDS.aradRo)
      .sort((a, b) => a.position - b.position);
    const clujSignals = signalRows
      .filter((row) => row.communityId === FOUNDATION_COMMUNITY_IDS.clujNapocaRo)
      .sort((a, b) => a.position - b.position);
    const sibiuSignals = signalRows
      .filter((row) => row.communityId === FOUNDATION_COMMUNITY_IDS.sibiuRo)
      .sort((a, b) => a.position - b.position);
    const iasiSignals = signalRows
      .filter((row) => row.communityId === FOUNDATION_COMMUNITY_IDS.iasiRo)
      .sort((a, b) => a.position - b.position);
    const timisoaraSignals = signalRows
      .filter((row) => row.communityId === FOUNDATION_COMMUNITY_IDS.timisoaraRo)
      .sort((a, b) => a.position - b.position);

    expect(milanoSignals.map((row) => row.slug)).toEqual([
      'milano-signal-1',
      'milano-signal-2',
      'milano-signal-3',
    ]);
    expect(munichSignals.map((row) => row.slug)).toEqual([
      'munich-signal-1',
      'munich-signal-2',
      'munich-signal-3',
    ]);
    expect(aradSignals.map((row) => row.slug)).toEqual([
      'arad-signal-1',
      'arad-signal-2',
      'arad-signal-3',
    ]);
    expect(clujSignals.map((row) => row.slug)).toEqual([
      'cluj-napoca-signal-1',
      'cluj-napoca-signal-2',
      'cluj-napoca-signal-3',
    ]);
    expect(sibiuSignals.map((row) => row.slug)).toEqual([
      'sibiu-signal-1',
      'sibiu-signal-2',
      'sibiu-signal-3',
    ]);
    expect(iasiSignals.map((row) => row.slug)).toEqual([
      'iasi-signal-1',
      'iasi-signal-2',
      'iasi-signal-3',
    ]);
    expect(timisoaraSignals.map((row) => row.slug)).toEqual([
      'timisoara-signal-1',
      'timisoara-signal-2',
      'timisoara-signal-3',
    ]);
    expect(milanoSignals.map((row) => row.position)).toEqual([1, 2, 3]);
    expect(munichSignals.map((row) => row.position)).toEqual([1, 2, 3]);
    expect(aradSignals.map((row) => row.position)).toEqual([1, 2, 3]);
    expect(clujSignals.map((row) => row.position)).toEqual([1, 2, 3]);
    expect(sibiuSignals.map((row) => row.position)).toEqual([1, 2, 3]);
    expect(iasiSignals.map((row) => row.position)).toEqual([1, 2, 3]);
    expect(timisoaraSignals.map((row) => row.position)).toEqual([1, 2, 3]);
    expect(milanoSignals.every((row) => row.locale === 'it-IT')).toBe(true);
    expect(munichSignals.every((row) => row.locale === 'de-DE')).toBe(true);
    expect(aradSignals.every((row) => row.locale === 'ro-RO')).toBe(true);
    expect(clujSignals.every((row) => row.locale === 'ro-RO')).toBe(true);
    expect(sibiuSignals.every((row) => row.locale === 'ro-RO')).toBe(true);
    expect(iasiSignals.every((row) => row.locale === 'ro-RO')).toBe(true);
    expect(timisoaraSignals.every((row) => row.locale === 'ro-RO')).toBe(true);
  });

  it('is idempotent and does not drift timestamps or create duplicates', async () => {
    const beforeCommunities = (await database.db.select().from(communities))
      .map(normalizeCommunity)
      .sort((a, b) => a.id.localeCompare(b.id));
    const beforeSignals = (await database.db.select().from(signals))
      .map(normalizeSignal)
      .sort((a, b) => a.id.localeCompare(b.id));

    await seedFoundationContent(database.db);
    await seedFoundationContent(database.db);

    const afterCommunities = (await database.db.select().from(communities))
      .map(normalizeCommunity)
      .sort((a, b) => a.id.localeCompare(b.id));
    const afterSignals = (await database.db.select().from(signals))
      .map(normalizeSignal)
      .sort((a, b) => a.id.localeCompare(b.id));

    expect(afterCommunities).toHaveLength(22);
    expect(afterSignals).toHaveLength(66);
    expect(afterCommunities).toEqual(beforeCommunities);
    expect(afterSignals).toEqual(beforeSignals);
  });

  it('matches the canonical manifest record-for-record', async () => {
    for (const expected of FOUNDATION_COMMUNITIES) {
      const rows = await database.db
        .select()
        .from(communities)
        .where(eq(communities.id, expected.id));
      const row = rows[0];
      expect(row).toBeDefined();
      if (!row) {
        throw new Error(`Missing community ${expected.id}`);
      }
      expect(normalizeCommunity(row)).toEqual(expected);
    }

    for (const expected of FOUNDATION_SIGNALS) {
      const rows = await database.db.select().from(signals).where(eq(signals.id, expected.id));
      const row = rows[0];
      expect(row).toBeDefined();
      if (!row) {
        throw new Error(`Missing signal ${expected.id}`);
      }
      expect(normalizeSignal(row)).toEqual(expected);
    }
  });

  it('does not use current-time values for canonical timestamps', async () => {
    const nowish = await database.db.execute<{ now: string }>(sql`select now()::text as now`);
    const now = new Date(nowish.rows[0]?.now ?? '');
    for (const signal of FOUNDATION_SIGNALS) {
      expect(new Date(signal.publishedAt).getTime()).toBeLessThan(now.getTime());
      expect(signal.publishedAt).toBe(signal.createdAt);
      expect(signal.updatedAt).toBe(signal.createdAt);
    }
  });
});
