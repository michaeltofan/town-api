import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDatabase, type Database } from '../src/db/client.js';
import {
  identitySecurityEvents,
  membershipEntitlements,
  membershipSourceEvents,
  type MembershipEntitlementRow,
  type MembershipStatus,
} from '../src/db/schema.js';
import { createAccountShell } from '../src/identity/repositories/accounts.js';
import { evaluateCivicAccess } from '../src/membership/civic-access.js';
import { suspendMembership } from '../src/membership/transitions/suspend.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

const CREATED_AT = '2026-07-01T00:00:00.000Z';
const ACTIVATED_AT = '2026-07-02T00:00:00.000Z';
const ACCESS_UNTIL = '2026-09-01T00:00:00.000Z';

describe('suspend membership transition', () => {
  let pool: Pool;
  let database: Database;
  let fixtureSequence = 0;

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

  async function createEntitlement(
    status: MembershipStatus,
    overrides: Partial<MembershipEntitlementRow> = {},
  ): Promise<MembershipEntitlementRow> {
    fixtureSequence += 1;
    const suffix = fixtureSequence.toString().padStart(3, '0');
    const accountId = `11000000-0000-4000-8000-000000000${suffix}`;
    const entitlementId = `31000000-0000-4000-8000-000000000${suffix}`;
    await createAccountShell(database.db, {
      id: accountId,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    const rows = await database.db
      .insert(membershipEntitlements)
      .values({
        id: entitlementId,
        accountId,
        status,
        accessUntil: ACCESS_UNTIL,
        cancelAtPeriodEnd: false,
        source: 'test_fixture',
        sourceCustomerId: `customer-${suffix}`,
        sourceSubscriptionId: `subscription-${suffix}`,
        activatedAt: ACTIVATED_AT,
        cancellationRequestedAt: null,
        expiredAt: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        version: 1,
        ...overrides,
      })
      .returning();
    const entitlement = rows[0];
    if (!entitlement) {
      throw new Error('Failed to create suspend membership test entitlement');
    }
    return entitlement;
  }

  async function readEntitlement(accountId: string): Promise<MembershipEntitlementRow> {
    const rows = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountId))
      .limit(1);
    const entitlement = rows[0];
    if (!entitlement) {
      throw new Error('Suspend membership test entitlement not found');
    }
    return entitlement;
  }

  it('suspends active membership while preserving every stored field even after access elapsed', async () => {
    const accessUntil = '2026-07-10T00:00:00.000Z';
    const before = await createEntitlement('active', { accessUntil });
    const effectiveAt = '2026-07-20T00:00:00.000Z';
    const outcome = await suspendMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_suspend_active',
        eventType: 'suspend',
        accountId: before.accountId,
        effectiveAt,
      },
      { nodeEnv: 'test', processedAt: effectiveAt },
    );

    expect(outcome.result).toBe('applied');
    const persisted = await readEntitlement(before.accountId);
    expect(persisted.status).toBe('suspended');
    expect(persisted.accessUntil).toBe(before.accessUntil);
    expect(persisted.cancelAtPeriodEnd).toBe(false);
    expect(persisted.activatedAt).toBe(before.activatedAt);
    expect(persisted.cancellationRequestedAt).toBe(before.cancellationRequestedAt);
    expect(persisted.expiredAt).toBeNull();
    expect(persisted.source).toBe(before.source);
    expect(persisted.sourceCustomerId).toBe(before.sourceCustomerId);
    expect(persisted.sourceSubscriptionId).toBe(before.sourceSubscriptionId);
    expect(persisted.version).toBe(before.version + 1);

    const sourceEvents = await database.db
      .select()
      .from(membershipSourceEvents)
      .where(
        and(
          eq(membershipSourceEvents.sourceEventId, 'evt_suspend_active'),
          eq(membershipSourceEvents.eventType, 'suspend'),
        ),
      );
    expect(sourceEvents).toHaveLength(1);
    expect(sourceEvents[0]?.result).toBe('applied');

    const auditEvents = await database.db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, before.accountId),
          eq(identitySecurityEvents.eventType, 'membership_suspended'),
        ),
      );
    expect(auditEvents).toHaveLength(1);
  });

  it('suspends cancelling membership without losing cancellation state', async () => {
    const cancellationRequestedAt = '2026-07-15T00:00:00.000Z';
    const before = await createEntitlement('cancelling', {
      cancelAtPeriodEnd: true,
      cancellationRequestedAt,
    });
    const outcome = await suspendMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_suspend_cancelling',
        eventType: 'suspend',
        accountId: before.accountId,
        effectiveAt: '2026-07-20T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-20T00:00:00.000Z' },
    );

    expect(outcome.result).toBe('applied');
    const persisted = await readEntitlement(before.accountId);
    expect(persisted.status).toBe('suspended');
    expect(persisted.accessUntil).toBe(before.accessUntil);
    expect(persisted.cancelAtPeriodEnd).toBe(true);
    expect(persisted.cancellationRequestedAt).toBe(before.cancellationRequestedAt);
    expect(persisted.activatedAt).toBe(before.activatedAt);
    expect(persisted.expiredAt).toBeNull();
  });

  it.each([
    {
      status: 'inactive' as const,
      overrides: {
        accessUntil: null,
        activatedAt: null,
        sourceCustomerId: null,
        sourceSubscriptionId: null,
      },
    },
    {
      status: 'paid_pending_binding' as const,
      overrides: {
        activatedAt: null,
        sourceCustomerId: null,
        sourceSubscriptionId: null,
      },
    },
    { status: 'suspended' as const, overrides: {} },
    {
      status: 'expired' as const,
      overrides: {
        accessUntil: '2026-07-10T00:00:00.000Z',
        expiredAt: '2026-07-10T00:00:00.000Z',
      },
    },
  ])('rejects $status without mutating the entitlement', async ({ status, overrides }) => {
    const before = await createEntitlement(status, overrides);
    const sourceEventId = `evt_suspend_reject_${status}`;
    const outcome = await suspendMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId,
        eventType: 'suspend',
        accountId: before.accountId,
        effectiveAt: '2026-07-20T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-20T00:00:00.000Z' },
    );

    expect(outcome.result).toBe('rejected');
    expect(outcome.reason).toBe('not_suspendable');
    expect(await readEntitlement(before.accountId)).toEqual(before);

    const sourceEvents = await database.db
      .select()
      .from(membershipSourceEvents)
      .where(eq(membershipSourceEvents.sourceEventId, sourceEventId));
    expect(sourceEvents).toHaveLength(1);
    expect(sourceEvents[0]?.result).toBe('rejected');

    const auditEvents = await database.db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, before.accountId),
          eq(identitySecurityEvents.eventType, 'membership_event_rejected'),
        ),
      );
    expect(auditEvents).toHaveLength(1);
  });

  it('replays identical input and rejects a payload-hash mismatch without another mutation', async () => {
    const before = await createEntitlement('active');
    const payload = {
      source: 'test_fixture' as const,
      sourceEventId: 'evt_suspend_idempotency',
      eventType: 'suspend' as const,
      accountId: before.accountId,
      effectiveAt: '2026-07-20T00:00:00.000Z',
    };
    const first = await suspendMembership(database.db, payload, {
      nodeEnv: 'test',
      processedAt: payload.effectiveAt,
    });
    expect(first.result).toBe('applied');
    const afterFirst = await readEntitlement(before.accountId);

    const replay = await suspendMembership(database.db, payload, {
      nodeEnv: 'test',
      processedAt: '2026-07-21T00:00:00.000Z',
    });
    expect(replay.result).toBe('replayed');
    expect(await readEntitlement(before.accountId)).toEqual(afterFirst);

    const conflict = await suspendMembership(
      database.db,
      { ...payload, effectiveAt: '2026-07-22T00:00:00.000Z' },
      { nodeEnv: 'test', processedAt: '2026-07-22T00:00:00.000Z' },
    );
    expect(conflict.result).toBe('rejected');
    expect(conflict.reason).toBe('payload_hash_mismatch');
    expect(await readEntitlement(before.accountId)).toEqual(afterFirst);

    const sourceEvents = await database.db
      .select()
      .from(membershipSourceEvents)
      .where(eq(membershipSourceEvents.sourceEventId, payload.sourceEventId));
    expect(sourceEvents).toHaveLength(1);
    expect(sourceEvents[0]?.result).toBe('applied');
  });

  it('removes civic participation after suspension', async () => {
    const before = await createEntitlement('active');
    const outcome = await suspendMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_suspend_civic_access',
        eventType: 'suspend',
        accountId: before.accountId,
        effectiveAt: '2026-07-20T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-20T00:00:00.000Z' },
    );
    expect(outcome.result).toBe('applied');
    const suspended = await readEntitlement(before.accountId);

    const access = evaluateCivicAccess({
      session: { accountId: before.accountId },
      account: { id: before.accountId, status: 'active' },
      entitlement: suspended,
      actor: {
        id: '21000000-0000-4000-8000-000000000001',
        accountId: before.accountId,
        communityId: '00000000-0000-4000-8000-000000000001',
        kind: 'civic',
        status: 'active',
      },
      communityId: '00000000-0000-4000-8000-000000000001',
      localEligibility: 'eligible',
      now: '2026-07-20T00:00:00.000Z',
    });
    expect(access.canParticipate).toBe(false);
    expect(access.denialReason).toBe('inactive_membership');
  });
});
