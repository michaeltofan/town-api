import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  membershipEntitlements,
  type MembershipEntitlementRow,
  type MembershipSource,
  type MembershipStatus,
} from '../../db/schema.js';

type Db = Database['db'];

export async function findEntitlementByAccountId(
  db: Db,
  accountId: string,
): Promise<MembershipEntitlementRow | null> {
  const rows = await db
    .select()
    .from(membershipEntitlements)
    .where(eq(membershipEntitlements.accountId, accountId))
    .limit(1);
  return rows[0] ?? null;
}

export async function lockEntitlementByAccountId(
  db: Db,
  accountId: string,
): Promise<MembershipEntitlementRow | null> {
  const locked = await db.execute<{
    id: string;
    account_id: string;
    status: string;
    access_until: string | null;
    cancel_at_period_end: boolean;
    source: string;
    source_customer_id: string | null;
    source_subscription_id: string | null;
    activated_at: string | null;
    cancellation_requested_at: string | null;
    expired_at: string | null;
    created_at: string;
    updated_at: string;
    version: number;
  }>(sql`
    SELECT id, account_id, status, access_until, cancel_at_period_end, source,
           source_customer_id, source_subscription_id, activated_at,
           cancellation_requested_at, expired_at, created_at, updated_at, version
    FROM town.membership_entitlements
    WHERE account_id = ${accountId}
    FOR UPDATE
  `);
  const row = locked.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    accountId: row.account_id,
    status: row.status as MembershipStatus,
    accessUntil: row.access_until,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    source: row.source as MembershipSource,
    sourceCustomerId: row.source_customer_id,
    sourceSubscriptionId: row.source_subscription_id,
    activatedAt: row.activated_at,
    cancellationRequestedAt: row.cancellation_requested_at,
    expiredAt: row.expired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export async function insertMembershipEntitlement(
  db: Db,
  input: {
    id: string;
    accountId: string;
    status: MembershipEntitlementRow['status'];
    accessUntil: string | null;
    cancelAtPeriodEnd: boolean;
    source: MembershipSource;
    sourceCustomerId: string | null;
    sourceSubscriptionId: string | null;
    activatedAt: string | null;
    cancellationRequestedAt: string | null;
    expiredAt: string | null;
    createdAt: string;
    updatedAt: string;
    version: number;
  },
): Promise<MembershipEntitlementRow> {
  const rows = await db
    .insert(membershipEntitlements)
    .values({
      id: input.id,
      accountId: input.accountId,
      status: input.status,
      accessUntil: input.accessUntil,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd,
      source: input.source,
      sourceCustomerId: input.sourceCustomerId,
      sourceSubscriptionId: input.sourceSubscriptionId,
      activatedAt: input.activatedAt,
      cancellationRequestedAt: input.cancellationRequestedAt,
      expiredAt: input.expiredAt,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      version: input.version,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to insert membership entitlement');
  }
  return row;
}

export async function updateMembershipEntitlement(
  db: Db,
  input: {
    id: string;
    status: MembershipEntitlementRow['status'];
    accessUntil: string | null;
    cancelAtPeriodEnd: boolean;
    source: MembershipSource;
    sourceCustomerId: string | null;
    sourceSubscriptionId: string | null;
    activatedAt: string | null;
    cancellationRequestedAt: string | null;
    expiredAt: string | null;
    updatedAt: string;
    version: number;
  },
): Promise<MembershipEntitlementRow> {
  const rows = await db
    .update(membershipEntitlements)
    .set({
      status: input.status,
      accessUntil: input.accessUntil,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd,
      source: input.source,
      sourceCustomerId: input.sourceCustomerId,
      sourceSubscriptionId: input.sourceSubscriptionId,
      activatedAt: input.activatedAt,
      cancellationRequestedAt: input.cancellationRequestedAt,
      expiredAt: input.expiredAt,
      updatedAt: input.updatedAt,
      version: input.version,
    })
    .where(eq(membershipEntitlements.id, input.id))
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to update membership entitlement');
  }
  return row;
}

export async function findExpiredMembershipCandidates(
  db: Db,
  input: { now: string; batchSize: number },
): Promise<MembershipEntitlementRow[]> {
  const locked = await db.execute<{
    id: string;
    account_id: string;
    status: string;
    access_until: string | null;
    cancel_at_period_end: boolean;
    source: string;
    source_customer_id: string | null;
    source_subscription_id: string | null;
    activated_at: string | null;
    cancellation_requested_at: string | null;
    expired_at: string | null;
    created_at: string;
    updated_at: string;
    version: number;
  }>(sql`
    SELECT id, account_id, status, access_until, cancel_at_period_end, source,
           source_customer_id, source_subscription_id, activated_at,
           cancellation_requested_at, expired_at, created_at, updated_at, version
    FROM town.membership_entitlements
    WHERE status IN ('active', 'cancelling')
      AND access_until IS NOT NULL
      AND access_until <= ${input.now}
    ORDER BY access_until ASC
    LIMIT ${input.batchSize}
    FOR UPDATE SKIP LOCKED
  `);

  return locked.rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    status: row.status as MembershipStatus,
    accessUntil: row.access_until,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    source: row.source as MembershipSource,
    sourceCustomerId: row.source_customer_id,
    sourceSubscriptionId: row.source_subscription_id,
    activatedAt: row.activated_at,
    cancellationRequestedAt: row.cancellation_requested_at,
    expiredAt: row.expired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  }));
}
