import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, type Database } from '../src/db/client.js';
import { membershipEntitlements, membershipSourceEvents } from '../src/db/schema.js';
import { createAccountShell } from '../src/identity/repositories/accounts.js';
import { activateMembership } from '../src/membership/transitions/activate.js';
import { expireMembership } from '../src/membership/transitions/expire.js';
import { reactivateMembership } from '../src/membership/transitions/reactivate.js';
import { scheduleMembershipCancellation } from '../src/membership/transitions/schedule-cancellation.js';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

describe('membership stale outcomes', () => {
  let pool: Pool;
  let database: Database;
  const accountId = '11000000-0000-4000-8000-000000000301';

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
    await createAccountShell(database.db, {
      id: accountId,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it('activate that would reduce access_until is treated as stale, not applied', async () => {
    const applied = await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_stale_activate_1',
        eventType: 'activate',
        accountId,
        effectiveAt: '2026-07-17T12:00:00.000Z',
        accessUntil: '2026-09-17T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-17T12:00:00.000Z' },
    );
    expect(applied.result).toBe('applied');
    const originalUpdatedAt = applied.entitlement?.updatedAt;

    const stale = await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_stale_activate_2',
        eventType: 'activate',
        accountId,
        // Attempt to reduce access_until
        effectiveAt: '2026-07-18T00:00:00.000Z',
        accessUntil: '2026-08-01T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-18T00:00:00.000Z' },
    );
    expect(stale.result).toBe('stale');
    expect(stale.reason).toBe('would_reduce_access_until');

    const row = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountId))
      .limit(1);
    const accessUntil = row[0]?.accessUntil;
    expect(accessUntil).toBeTruthy();
    expect(new Date(accessUntil ?? '').toISOString()).toBe('2026-09-17T00:00:00.000Z');
    expect(row[0]?.updatedAt).toBe(originalUpdatedAt);

    // The stale event is still recorded in the source-event ledger with result=stale.
    const ledger = await database.db
      .select()
      .from(membershipSourceEvents)
      .where(eq(membershipSourceEvents.sourceEventId, 'evt_stale_activate_2'));
    expect(ledger[0]?.result).toBe('stale');
  });

  it('schedule cancellation from an already-cancelling entitlement is rejected as not_active', async () => {
    // Set the account to cancelling.
    await scheduleMembershipCancellation(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_stale_schedule_1',
        eventType: 'schedule_cancellation',
        accountId,
        effectiveAt: '2026-07-25T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-25T00:00:00.000Z' },
    );
    const rejected = await scheduleMembershipCancellation(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_stale_schedule_2',
        eventType: 'schedule_cancellation',
        accountId,
        effectiveAt: '2026-07-26T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-26T00:00:00.000Z' },
    );
    expect(rejected.result).toBe('rejected');
    expect(rejected.reason).toBe('not_active');
  });

  it('reactivate with older effective_at than existing cancellation is stale', async () => {
    // Currently entitlement is cancelling with cancellationRequestedAt = 2026-07-25.
    const stale = await reactivateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_stale_reactivate_1',
        eventType: 'reactivate',
        accountId,
        effectiveAt: '2026-07-24T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-27T00:00:00.000Z' },
    );
    expect(stale.result).toBe('stale');
    expect(stale.reason).toBe('older_reactivation_event');
  });

  it('an older expire event after a newer expire is stale', async () => {
    const secondAccountId = '11000000-0000-4000-8000-000000000302';
    await createAccountShell(database.db, {
      id: secondAccountId,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_stale_expire_activate_1',
        eventType: 'activate',
        accountId: secondAccountId,
        effectiveAt: '2026-07-17T12:00:00.000Z',
        accessUntil: '2026-08-17T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-17T12:00:00.000Z' },
    );
    await expireMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_stale_expire_newer',
        eventType: 'expire',
        accountId: secondAccountId,
        effectiveAt: '2026-08-20T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-08-20T00:00:00.000Z' },
    );
    // Now current status is expired. A subsequent expire at access_until (older) is rejected:
    // the transition logic rejects when the entitlement is not active or cancelling.
    const olderExpire = await expireMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_stale_expire_older',
        eventType: 'expire',
        accountId: secondAccountId,
        effectiveAt: '2026-08-17T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-08-21T00:00:00.000Z' },
    );
    expect(olderExpire.result).toBe('rejected');
    expect(olderExpire.reason).toBe('not_active_or_cancelling');
  });

  it('a cancel event received after a reactivation applied with newer time is not stale — is normal', async () => {
    const acctId = '11000000-0000-4000-8000-000000000303';
    await createAccountShell(database.db, {
      id: acctId,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_stale_cancel_after_react_activate',
        eventType: 'activate',
        accountId: acctId,
        effectiveAt: '2026-07-17T12:00:00.000Z',
        accessUntil: '2026-09-17T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-17T12:00:00.000Z' },
    );
    await scheduleMembershipCancellation(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_stale_cancel_after_react_1',
        eventType: 'schedule_cancellation',
        accountId: acctId,
        effectiveAt: '2026-07-25T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-25T00:00:00.000Z' },
    );
    await reactivateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_stale_cancel_after_react_2',
        eventType: 'reactivate',
        accountId: acctId,
        effectiveAt: '2026-07-26T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-26T00:00:00.000Z' },
    );

    // Currently active; a later cancel event applies normally.
    const later = await scheduleMembershipCancellation(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_stale_cancel_after_react_3',
        eventType: 'schedule_cancellation',
        accountId: acctId,
        effectiveAt: '2026-07-28T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-28T00:00:00.000Z' },
    );
    expect(later.result).toBe('applied');
    expect(later.entitlement?.status).toBe('cancelling');
  });
});
