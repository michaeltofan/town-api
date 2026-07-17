import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDatabase, type Database } from '../src/db/client.js';
import { membershipEntitlements, membershipSourceEvents } from '../src/db/schema.js';
import { createAccountShell } from '../src/identity/repositories/accounts.js';
import { activateMembership } from '../src/membership/transitions/activate.js';
import { expireMembership } from '../src/membership/transitions/expire.js';
import { scheduleMembershipCancellation } from '../src/membership/transitions/schedule-cancellation.js';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

describe('membership concurrency', () => {
  let pool: Pool;
  let database: Database;

  beforeAll(async () => {
    const url = requireDatabaseUrl();
    pool = new Pool({ connectionString: url, max: 1 });
    await resetMigrateSeedFoundationAndActor(pool);
    database = createDatabase({
      connectionString: url,
      poolMax: 10,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it('Promise.all identical activations yields exactly one applied and the rest replayed', async () => {
    const accountId = '11000000-0000-4000-8000-000000000401';
    await createAccountShell(database.db, {
      id: accountId,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    const payload = {
      source: 'test_fixture' as const,
      sourceEventId: 'evt_concurrent_activate',
      eventType: 'activate' as const,
      accountId,
      effectiveAt: '2026-07-17T12:00:00.000Z',
      accessUntil: '2026-08-17T00:00:00.000Z',
    };
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        activateMembership(database.db, payload, {
          nodeEnv: 'test',
          processedAt: '2026-07-17T12:00:00.000Z',
        }),
      ),
    );
    const results = outcomes.map((o) => o.result).sort();
    expect(results.filter((r) => r === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r === 'replayed')).toHaveLength(4);

    const ledger = await database.db
      .select()
      .from(membershipSourceEvents)
      .where(
        and(
          eq(membershipSourceEvents.source, 'test_fixture'),
          eq(membershipSourceEvents.sourceEventId, 'evt_concurrent_activate'),
        ),
      );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.result).toBe('applied');

    const ent = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountId))
      .limit(1);
    expect(Number(ent[0]?.version)).toBe(1);
  });

  it('activate/cancel race ends in a valid state (active or cancelling), each event uniquely persisted', async () => {
    const accountId = '11000000-0000-4000-8000-000000000402';
    await createAccountShell(database.db, {
      id: accountId,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    // First activate synchronously so a cancel target exists.
    await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_race_activate_first',
        eventType: 'activate',
        accountId,
        effectiveAt: '2026-07-17T12:00:00.000Z',
        accessUntil: '2026-09-17T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-17T12:00:00.000Z' },
    );
    const [activateOutcome, cancelOutcome] = await Promise.all([
      activateMembership(
        database.db,
        {
          source: 'test_fixture',
          sourceEventId: 'evt_race_activate_second',
          eventType: 'activate',
          accountId,
          effectiveAt: '2026-07-18T12:00:00.000Z',
          accessUntil: '2026-10-17T00:00:00.000Z',
        },
        { nodeEnv: 'test', processedAt: '2026-07-18T12:00:00.000Z' },
      ),
      scheduleMembershipCancellation(
        database.db,
        {
          source: 'test_fixture',
          sourceEventId: 'evt_race_cancel',
          eventType: 'schedule_cancellation',
          accountId,
          effectiveAt: '2026-07-18T12:00:01.000Z',
        },
        { nodeEnv: 'test', processedAt: '2026-07-18T12:00:01.000Z' },
      ),
    ]);
    // Regardless of ordering, both events are recorded — outcomes are valid.
    expect(['applied', 'stale', 'rejected']).toContain(activateOutcome.result);
    expect(['applied', 'stale', 'rejected']).toContain(cancelOutcome.result);

    const ent = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountId))
      .limit(1);
    expect(['active', 'cancelling']).toContain(ent[0]?.status);

    const ledger = await database.db
      .select()
      .from(membershipSourceEvents)
      .where(eq(membershipSourceEvents.accountId, accountId));
    const sourceIds = ledger.map((row) => row.sourceEventId);
    expect(sourceIds).toContain('evt_race_activate_second');
    expect(sourceIds).toContain('evt_race_cancel');
  });

  it('expire/activate race preserves invariant that the entitlement remains readable and valid', async () => {
    const accountId = '11000000-0000-4000-8000-000000000403';
    await createAccountShell(database.db, {
      id: accountId,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_race_expire_activate_setup',
        eventType: 'activate',
        accountId,
        effectiveAt: '2026-07-17T12:00:00.000Z',
        accessUntil: '2026-08-17T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-17T12:00:00.000Z' },
    );

    const [expireOutcome, activateOutcome] = await Promise.all([
      expireMembership(
        database.db,
        {
          source: 'test_fixture',
          sourceEventId: 'evt_race_expire_1',
          eventType: 'expire',
          accountId,
          effectiveAt: '2026-08-17T00:00:00.000Z',
        },
        { nodeEnv: 'test', processedAt: '2026-08-17T00:00:00.000Z' },
      ),
      activateMembership(
        database.db,
        {
          source: 'test_fixture',
          sourceEventId: 'evt_race_activate_new',
          eventType: 'activate',
          accountId,
          effectiveAt: '2026-08-17T00:00:01.000Z',
          accessUntil: '2026-10-17T00:00:00.000Z',
        },
        { nodeEnv: 'test', processedAt: '2026-08-17T00:00:01.000Z' },
      ),
    ]);
    expect(['applied', 'stale', 'rejected']).toContain(expireOutcome.result);
    expect(['applied', 'stale', 'rejected']).toContain(activateOutcome.result);

    const ent = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountId))
      .limit(1);
    expect(['expired', 'active']).toContain(ent[0]?.status);
  });
});
