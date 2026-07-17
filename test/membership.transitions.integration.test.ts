import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, type Database } from '../src/db/client.js';
import {
  accounts,
  identitySecurityEvents,
  membershipEntitlements,
  membershipSourceEvents,
} from '../src/db/schema.js';
import { createAccountShell } from '../src/identity/repositories/accounts.js';
import { activateMembership } from '../src/membership/transitions/activate.js';
import { expireMembership } from '../src/membership/transitions/expire.js';
import { reactivateMembership } from '../src/membership/transitions/reactivate.js';
import { scheduleMembershipCancellation } from '../src/membership/transitions/schedule-cancellation.js';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

function iso(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return new Date(value).toISOString();
}

async function makeShellAccount(
  database: Database,
  id: string,
  overrides: { closed?: boolean } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await createAccountShell(database.db, { id, createdAt: now, updatedAt: now });
  if (overrides.closed) {
    // Direct SQL to close bypassing full active requirements. Closed accounts require a
    // webauthn_user_handle to satisfy the account state timestamps check.
    const handle = Buffer.alloc(32, 0x2a);
    await database.db
      .update(accounts)
      .set({
        webauthnUserHandle: handle,
        status: 'closed',
        accountReadyAt: now,
        closedAt: now,
        updatedAt: now,
      })
      .where(eq(accounts.id, id));
  }
}

describe('membership transitions', () => {
  let pool: Pool;
  let database: Database;
  const activeAccountId = '11000000-0000-4000-8000-000000000101';
  const closedAccountId = '11000000-0000-4000-8000-000000000102';
  const secondAccountId = '11000000-0000-4000-8000-000000000103';
  const thirdAccountId = '11000000-0000-4000-8000-000000000104';
  const fourthAccountId = '11000000-0000-4000-8000-000000000105';
  const fifthAccountId = '11000000-0000-4000-8000-000000000106';

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
    await makeShellAccount(database, activeAccountId);
    await makeShellAccount(database, closedAccountId, { closed: true });
    await makeShellAccount(database, secondAccountId);
    await makeShellAccount(database, thirdAccountId);
    await makeShellAccount(database, fourthAccountId);
    await makeShellAccount(database, fifthAccountId);
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it('activate on absent entitlement creates membership_created and membership_activated events, version 1', async () => {
    const effectiveAt = '2026-07-17T12:00:00.000Z';
    const outcome = await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_activate_absent_1',
        eventType: 'activate',
        accountId: activeAccountId,
        effectiveAt,
        accessUntil: '2026-08-17T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: effectiveAt },
    );
    expect(outcome.result).toBe('applied');
    expect(outcome.entitlement?.status).toBe('active');
    expect(Number(outcome.entitlement?.version)).toBe(1);
    expect(iso(outcome.entitlement?.activatedAt)).toBe(effectiveAt);
    expect(outcome.entitlement?.cancelAtPeriodEnd).toBe(false);

    const events = await database.db
      .select()
      .from(identitySecurityEvents)
      .where(eq(identitySecurityEvents.accountId, activeAccountId));
    const types = events.map((e) => e.eventType);
    expect(types).toContain('membership_created');
    expect(types).toContain('membership_activated');
  });

  it('is rejected on a closed account', async () => {
    const outcome = await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_activate_closed_1',
        eventType: 'activate',
        accountId: closedAccountId,
        effectiveAt: '2026-07-17T12:00:00.000Z',
        accessUntil: '2026-08-17T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-17T12:00:00.000Z' },
    );
    expect(outcome.result).toBe('rejected');
    expect(outcome.reason).toBe('account_closed');

    const sourceEvents = await database.db
      .select()
      .from(membershipSourceEvents)
      .where(eq(membershipSourceEvents.sourceEventId, 'evt_activate_closed_1'));
    expect(sourceEvents[0]?.result).toBe('rejected');
  });

  it('schedules cancellation and later reactivates from cancelling', async () => {
    const t0 = '2026-07-17T12:00:00.000Z';
    const activate = await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_activate_second_1',
        eventType: 'activate',
        accountId: secondAccountId,
        effectiveAt: t0,
        accessUntil: '2026-09-17T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: t0 },
    );
    expect(activate.result).toBe('applied');

    const t1 = '2026-07-20T12:00:00.000Z';
    const schedule = await scheduleMembershipCancellation(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_schedule_second_1',
        eventType: 'schedule_cancellation',
        accountId: secondAccountId,
        effectiveAt: t1,
      },
      { nodeEnv: 'test', processedAt: t1 },
    );
    expect(schedule.result).toBe('applied');
    expect(schedule.entitlement?.status).toBe('cancelling');
    expect(schedule.entitlement?.cancelAtPeriodEnd).toBe(true);
    expect(Number(schedule.entitlement?.version)).toBe(2);
    expect(iso(schedule.entitlement?.cancellationRequestedAt)).toBe(t1);

    const t2 = '2026-07-21T12:00:00.000Z';
    const reactivate = await reactivateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_reactivate_second_1',
        eventType: 'reactivate',
        accountId: secondAccountId,
        effectiveAt: t2,
      },
      { nodeEnv: 'test', processedAt: t2 },
    );
    expect(reactivate.result).toBe('applied');
    expect(reactivate.entitlement?.status).toBe('active');
    expect(reactivate.entitlement?.cancelAtPeriodEnd).toBe(false);
    expect(reactivate.entitlement?.cancellationRequestedAt).toBeNull();
    expect(Number(reactivate.entitlement?.version)).toBe(3);
  });

  it('rejects reactivate from a status other than cancelling', async () => {
    const t0 = '2026-07-17T12:00:00.000Z';
    const activate = await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_activate_third_1',
        eventType: 'activate',
        accountId: thirdAccountId,
        effectiveAt: t0,
        accessUntil: '2026-08-17T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: t0 },
    );
    expect(activate.result).toBe('applied');

    const reactivate = await reactivateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_reactivate_third_1',
        eventType: 'reactivate',
        accountId: thirdAccountId,
        effectiveAt: '2026-07-18T12:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-18T12:00:00.000Z' },
    );
    expect(reactivate.result).toBe('rejected');
    expect(reactivate.reason).toBe('not_cancelling');
  });

  it('expire before access_until is rejected, expire at access_until is applied', async () => {
    const t0 = '2026-07-17T12:00:00.000Z';
    const accessUntil = '2026-08-17T00:00:00.000Z';
    await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_activate_fourth_1',
        eventType: 'activate',
        accountId: fourthAccountId,
        effectiveAt: t0,
        accessUntil,
      },
      { nodeEnv: 'test', processedAt: t0 },
    );

    const early = await expireMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_expire_fourth_early_1',
        eventType: 'expire',
        accountId: fourthAccountId,
        effectiveAt: '2026-07-25T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-25T00:00:00.000Z' },
    );
    expect(early.result).toBe('rejected');
    expect(early.reason).toBe('expire_too_early');

    const later = await expireMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_expire_fourth_ok_1',
        eventType: 'expire',
        accountId: fourthAccountId,
        effectiveAt: accessUntil,
      },
      { nodeEnv: 'test', processedAt: accessUntil },
    );
    expect(later.result).toBe('applied');
    expect(later.entitlement?.status).toBe('expired');
    expect(iso(later.entitlement?.expiredAt)).toBe(accessUntil);
    expect(iso(later.entitlement?.accessUntil)).toBe(accessUntil);
  });

  it('activate from expired resets to active; activate from cancelling transitions via activate', async () => {
    const t0 = '2026-07-17T12:00:00.000Z';
    await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_activate_fifth_1',
        eventType: 'activate',
        accountId: fifthAccountId,
        effectiveAt: t0,
        accessUntil: '2026-08-17T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: t0 },
    );
    await expireMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_expire_fifth_1',
        eventType: 'expire',
        accountId: fifthAccountId,
        effectiveAt: '2026-08-17T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-08-17T00:00:00.000Z' },
    );
    // Now expired; a new activation should return to active with a new access_until.
    const reactivateFromExpired = await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_activate_fifth_2',
        eventType: 'activate',
        accountId: fifthAccountId,
        effectiveAt: '2026-08-20T00:00:00.000Z',
        accessUntil: '2026-09-20T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-08-20T00:00:00.000Z' },
    );
    expect(reactivateFromExpired.result).toBe('applied');
    expect(reactivateFromExpired.entitlement?.status).toBe('active');
    expect(iso(reactivateFromExpired.entitlement?.accessUntil)).toBe('2026-09-20T00:00:00.000Z');

    // Schedule cancellation, then use activate again to re-enter active without cancel_at_period_end.
    await scheduleMembershipCancellation(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_schedule_fifth_2',
        eventType: 'schedule_cancellation',
        accountId: fifthAccountId,
        effectiveAt: '2026-08-25T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-08-25T00:00:00.000Z' },
    );

    const entRow = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, fifthAccountId))
      .limit(1);
    expect(entRow[0]?.status).toBe('cancelling');

    const activateFromCancelling = await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_activate_fifth_3',
        eventType: 'activate',
        accountId: fifthAccountId,
        effectiveAt: '2026-08-26T00:00:00.000Z',
        accessUntil: '2026-10-20T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-08-26T00:00:00.000Z' },
    );
    expect(activateFromCancelling.result).toBe('applied');
    expect(activateFromCancelling.entitlement?.status).toBe('active');
    expect(activateFromCancelling.entitlement?.cancelAtPeriodEnd).toBe(false);
    expect(iso(activateFromCancelling.entitlement?.accessUntil)).toBe('2026-10-20T00:00:00.000Z');
  });
});
