import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, type Database } from '../src/db/client.js';
import { membershipEntitlements } from '../src/db/schema.js';
import { createAccountShell } from '../src/identity/repositories/accounts.js';
import { activateMembership } from '../src/membership/transitions/activate.js';
import { reconcileExpiredMemberships } from '../src/membership/reconcile.js';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

describe('membership reconcile expired', () => {
  let pool: Pool;
  let database: Database;

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
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it('expires only entitlements whose access_until has elapsed, respects batch size, is idempotent', async () => {
    const ids: [string, string, string, string] = [
      '11000000-0000-4000-8000-000000000501',
      '11000000-0000-4000-8000-000000000502',
      '11000000-0000-4000-8000-000000000503',
      '11000000-0000-4000-8000-000000000504',
    ];
    for (const id of ids) {
      await createAccountShell(database.db, {
        id,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      });
    }
    // Three with elapsed access_until, one with future access_until.
    await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_reconcile_a',
        eventType: 'activate',
        accountId: ids[0],
        effectiveAt: '2026-07-01T00:00:00.000Z',
        accessUntil: '2026-07-10T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-01T00:00:00.000Z' },
    );
    await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_reconcile_b',
        eventType: 'activate',
        accountId: ids[1],
        effectiveAt: '2026-07-01T00:00:00.000Z',
        accessUntil: '2026-07-11T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-01T00:00:00.000Z' },
    );
    await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_reconcile_c',
        eventType: 'activate',
        accountId: ids[2],
        effectiveAt: '2026-07-01T00:00:00.000Z',
        accessUntil: '2026-07-12T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-01T00:00:00.000Z' },
    );
    await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_reconcile_future',
        eventType: 'activate',
        accountId: ids[3],
        effectiveAt: '2026-07-01T00:00:00.000Z',
        accessUntil: '2027-01-01T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-01T00:00:00.000Z' },
    );

    const now = '2026-07-17T00:00:00.000Z';

    // Batch size 2 — only two of the three eligible rows are processed.
    const firstBatch = await reconcileExpiredMemberships(database.db, {
      now,
      batchSize: 2,
      nodeEnv: 'test',
    });
    expect(firstBatch.processed).toBe(2);
    const firstApplied = firstBatch.results.filter((r) => r.result === 'applied').length;
    expect(firstApplied).toBe(2);

    // Second batch picks up the remaining one.
    const secondBatch = await reconcileExpiredMemberships(database.db, {
      now,
      batchSize: 10,
      nodeEnv: 'test',
    });
    expect(secondBatch.processed).toBe(1);
    expect(secondBatch.results[0]?.result).toBe('applied');

    // Repeating is idempotent — no candidates remain.
    const third = await reconcileExpiredMemberships(database.db, {
      now,
      batchSize: 10,
      nodeEnv: 'test',
    });
    expect(third.processed).toBe(0);

    const rows = await Promise.all(
      ids.map(async (id) => {
        const r = await database.db
          .select()
          .from(membershipEntitlements)
          .where(eq(membershipEntitlements.accountId, id))
          .limit(1);
        return r[0];
      }),
    );
    expect(rows[0]?.status).toBe('expired');
    expect(rows[1]?.status).toBe('expired');
    expect(rows[2]?.status).toBe('expired');
    // The one with future access_until is untouched.
    expect(rows[3]?.status).toBe('active');
  });

  it('does not expire memberships whose access_until is still in the future', async () => {
    const accountId = '11000000-0000-4000-8000-000000000510';
    await createAccountShell(database.db, {
      id: accountId,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_reconcile_future_only',
        eventType: 'activate',
        accountId,
        effectiveAt: '2026-07-17T00:00:00.000Z',
        accessUntil: '2027-01-01T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-17T00:00:00.000Z' },
    );
    const result = await reconcileExpiredMemberships(database.db, {
      now: '2026-07-17T00:00:00.000Z',
      batchSize: 10,
      nodeEnv: 'test',
    });
    // Should not have picked up this account.
    expect(result.results.some((r) => r.entitlement?.accountId === accountId)).toBe(false);
  });
});
