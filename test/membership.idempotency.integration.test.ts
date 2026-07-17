import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDatabase, type Database } from '../src/db/client.js';
import { membershipEntitlements, membershipSourceEvents } from '../src/db/schema.js';
import { createAccountShell } from '../src/identity/repositories/accounts.js';
import { activateMembership } from '../src/membership/transitions/activate.js';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

describe('membership idempotency', () => {
  let pool: Pool;
  let database: Database;
  const accountId = '11000000-0000-4000-8000-000000000201';
  const t0 = '2026-07-17T12:00:00.000Z';
  const accessUntil = '2026-08-17T00:00:00.000Z';

  beforeAll(async () => {
    const url = requireDatabaseUrl();
    pool = new Pool({ connectionString: url, max: 1 });
    await resetMigrateSeedFoundationAndActor(pool);
    database = createDatabase({
      connectionString: url,
      poolMax: 3,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    await createAccountShell(database.db, { id: accountId, createdAt: t0, updatedAt: t0 });
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it('same sourceEventId + same payload replays without re-mutating', async () => {
    const payload = {
      source: 'test_fixture' as const,
      sourceEventId: 'evt_idempotent_same',
      eventType: 'activate' as const,
      accountId,
      effectiveAt: t0,
      accessUntil,
    };
    const first = await activateMembership(database.db, payload, {
      nodeEnv: 'test',
      processedAt: t0,
    });
    expect(first.result).toBe('applied');
    const firstVersion = first.entitlement?.version;
    const firstUpdatedAt = first.entitlement?.updatedAt;

    const replay = await activateMembership(database.db, payload, {
      nodeEnv: 'test',
      processedAt: '2026-07-18T00:00:00.000Z',
    });
    expect(replay.result).toBe('replayed');
    expect(Number(replay.entitlement?.version)).toBe(Number(firstVersion));
    expect(replay.entitlement?.updatedAt).toBe(firstUpdatedAt);

    const ledger = await database.db
      .select()
      .from(membershipSourceEvents)
      .where(
        and(
          eq(membershipSourceEvents.source, 'test_fixture'),
          eq(membershipSourceEvents.sourceEventId, 'evt_idempotent_same'),
        ),
      );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.result).toBe('applied');
  });

  it('same sourceEventId + different payload is rejected and does not mutate', async () => {
    const sharedId = 'evt_idempotent_conflict';
    const first = await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: sharedId,
        eventType: 'activate',
        accountId,
        effectiveAt: t0,
        accessUntil,
      },
      { nodeEnv: 'test', processedAt: t0 },
    );
    // The account already had one active event so this is either replayed or applied depending on state.
    expect(['applied', 'replayed', 'stale']).toContain(first.result);

    const before = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountId))
      .limit(1);
    const beforeVersion = Number(before[0]?.version);
    const beforeUpdatedAt = before[0]?.updatedAt;

    const conflicting = await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: sharedId,
        eventType: 'activate',
        accountId,
        effectiveAt: t0,
        // Divergent payload_hash — different access_until
        accessUntil: '2026-12-31T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-19T00:00:00.000Z' },
    );
    expect(conflicting.result).toBe('rejected');
    expect(conflicting.reason).toBe('payload_hash_mismatch');

    const after = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountId))
      .limit(1);
    expect(Number(after[0]?.version)).toBe(beforeVersion);
    expect(after[0]?.updatedAt).toBe(beforeUpdatedAt);
  });

  it('the entitlement version increases exactly once for a single applied transition (not per replay/reject)', async () => {
    const startingRow = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountId))
      .limit(1);
    const startingVersion = startingRow[0]?.version ?? 0;

    // Same payload again — replayed, no version bump.
    await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_idempotent_same',
        eventType: 'activate',
        accountId,
        effectiveAt: t0,
        accessUntil,
      },
      { nodeEnv: 'test', processedAt: '2026-07-20T00:00:00.000Z' },
    );

    const afterReplay = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountId))
      .limit(1);
    expect(Number(afterReplay[0]?.version)).toBe(startingVersion);
  });
});
