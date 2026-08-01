import type { Database } from '../../db/client.js';
import type {
  MembershipEntitlementRow,
  MembershipSource,
  PlatformAuditAction,
} from '../../db/schema.js';
import {
  accountNotFoundError,
  membershipEntitlementNotFoundError,
  membershipOperationNotAllowedError,
  providerManagedMembershipError,
} from '../../errors/app-error.js';
import { findAccountById } from '../../identity/repositories/accounts.js';
import { findEntitlementByAccountId } from '../../membership/repositories/entitlements.js';
import { findSourceEventBySourceAndEventId } from '../../membership/repositories/source-events.js';
import { activateMembership } from '../../membership/transitions/activate.js';
import { scheduleMembershipCancellation } from '../../membership/transitions/schedule-cancellation.js';
import { appendPlatformAuditEvent } from '../repositories/audit.js';

type Db = Database['db'];

export type PlatformMembershipAllowedAction = 'extend' | 'schedule_cancellation';

export type PlatformMembershipSnapshot = {
  accountId: string;
  status: string;
  source: string;
  accessUntil: string | null;
  activatedAt: string | null;
  cancellationRequestedAt: string | null;
  cancelAtPeriodEnd: boolean;
  expiredAt: string | null;
  version: number;
};

const PROVIDER_SOURCES = new Set<MembershipSource>(['stripe', 'google_play']);
const GRANTABLE_LOCAL_SOURCES = new Set<MembershipSource>(['admin', 'test_fixture']);

function isProviderSource(source: string): source is MembershipSource {
  return PROVIDER_SOURCES.has(source as MembershipSource);
}

function sameInstant(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left == null || right == null) {
    return left == null && right == null;
  }
  return new Date(left).getTime() === new Date(right).getTime();
}

function snapshotOf(
  row: MembershipEntitlementRow | null,
  accountId: string,
): PlatformMembershipSnapshot {
  if (!row) {
    return {
      accountId,
      status: 'inactive',
      source: 'none',
      accessUntil: null,
      activatedAt: null,
      cancellationRequestedAt: null,
      cancelAtPeriodEnd: false,
      expiredAt: null,
      version: 0,
    };
  }
  return {
    accountId: row.accountId,
    status: row.status,
    source: row.source,
    accessUntil: row.accessUntil,
    activatedAt: row.activatedAt,
    cancellationRequestedAt: row.cancellationRequestedAt,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    expiredAt: row.expiredAt,
    version: row.version,
  };
}

export function computePlatformMembershipAllowedActions(input: {
  source: string;
  status: string;
}): PlatformMembershipAllowedAction[] {
  if (input.source === 'admin' && input.status === 'active') {
    return ['extend', 'schedule_cancellation'];
  }
  return [];
}

function assertNotProviderManaged(entitlement: MembershipEntitlementRow | null): void {
  if (entitlement && isProviderSource(entitlement.source)) {
    throw providerManagedMembershipError();
  }
}

function assertGrantEligible(entitlement: MembershipEntitlementRow | null): void {
  assertNotProviderManaged(entitlement);
  if (!entitlement) {
    return;
  }
  if (entitlement.status === 'inactive' || entitlement.status === 'expired') {
    if (!GRANTABLE_LOCAL_SOURCES.has(entitlement.source as MembershipSource)) {
      throw membershipOperationNotAllowedError(
        'Administrative grant is only allowed when no entitlement exists or the existing local entitlement is inactive or expired.',
      );
    }
    return;
  }
  throw membershipOperationNotAllowedError(
    'Administrative grant is not allowed while membership is active, cancelling, suspended, or pending binding.',
  );
}

function assertAdminActive(entitlement: MembershipEntitlementRow | null): MembershipEntitlementRow {
  if (!entitlement) {
    throw membershipEntitlementNotFoundError();
  }
  assertNotProviderManaged(entitlement);
  if (entitlement.source !== 'admin' || entitlement.status !== 'active') {
    throw membershipOperationNotAllowedError(
      'This operation is only allowed for active administratively granted memberships.',
    );
  }
  return entitlement;
}

async function writeMembershipAudit(
  db: Db,
  input: {
    id: string;
    operatorAccountId: string;
    action: PlatformAuditAction;
    occurredAt: string;
    requestId: string;
    targetAccountId: string;
    reason: string;
    before: PlatformMembershipSnapshot;
    after: PlatformMembershipSnapshot;
    result: string;
  },
): Promise<void> {
  await appendPlatformAuditEvent(db, {
    id: input.id,
    operatorAccountId: input.operatorAccountId,
    action: input.action,
    occurredAt: input.occurredAt,
    requestId: input.requestId,
    targetAccountId: input.targetAccountId,
    metadata: {
      reason: input.reason,
      result: input.result,
      beforeStatus: input.before.status,
      beforeSource: input.before.source,
      beforeAccessUntil: input.before.accessUntil,
      beforeCancelAtPeriodEnd: input.before.cancelAtPeriodEnd,
      beforeVersion: input.before.version,
      afterStatus: input.after.status,
      afterSource: input.after.source,
      afterAccessUntil: input.after.accessUntil,
      afterCancelAtPeriodEnd: input.after.cancelAtPeriodEnd,
      afterVersion: input.after.version,
    },
  });
}

export type PlatformMembershipMutationResult = {
  changed: boolean;
  before: PlatformMembershipSnapshot;
  after: PlatformMembershipSnapshot;
  allowedActions: PlatformMembershipAllowedAction[];
};

export async function grantPlatformMembership(
  db: Db,
  input: {
    accountId: string;
    accessUntil: string;
    reason: string;
    idempotencyKey: string;
    operatorAccountId: string;
    requestId: string;
    now: string;
    generateId: () => string;
  },
): Promise<PlatformMembershipMutationResult> {
  const account = await findAccountById(db, input.accountId);
  if (!account) {
    throw accountNotFoundError();
  }
  if (account.status === 'closed') {
    throw membershipOperationNotAllowedError('Closed accounts cannot receive membership grants.');
  }

  const sourceEventId = `platform:grant:${input.idempotencyKey}`;
  const existingEvent = await findSourceEventBySourceAndEventId(db, 'admin', sourceEventId);
  const existing = await findEntitlementByAccountId(db, input.accountId);

  if (existingEvent) {
    if (existingEvent.result !== 'applied' && existingEvent.result !== 'replayed') {
      throw membershipOperationNotAllowedError(
        'This idempotency key was previously rejected for membership grant.',
      );
    }
    if (existing && isProviderSource(existing.source)) {
      throw providerManagedMembershipError();
    }
    if (!existing || !sameInstant(existing.accessUntil, input.accessUntil)) {
      throw membershipOperationNotAllowedError(
        'Idempotency key reuse must repeat the original grant accessUntil.',
      );
    }
    const after = snapshotOf(existing, input.accountId);
    return {
      changed: false,
      before: after,
      after,
      allowedActions: computePlatformMembershipAllowedActions(after),
    };
  }

  assertGrantEligible(existing);
  const before = snapshotOf(existing, input.accountId);

  const outcome = await activateMembership(
    db,
    {
      source: 'admin',
      sourceEventId,
      eventType: 'activate',
      accountId: input.accountId,
      effectiveAt: input.now,
      accessUntil: input.accessUntil,
      sourceCustomerId: null,
      sourceSubscriptionId: null,
    },
    {
      processedAt: input.now,
      requestId: input.requestId,
      generateId: input.generateId,
    },
  );

  if (outcome.result === 'rejected' || outcome.result === 'stale') {
    throw membershipOperationNotAllowedError(
      outcome.reason ?? 'Membership grant was rejected by the entitlement transition model.',
    );
  }

  const afterRow = outcome.entitlement ?? (await findEntitlementByAccountId(db, input.accountId));
  const after = snapshotOf(afterRow, input.accountId);
  const changed = outcome.result === 'applied';

  if (changed) {
    await writeMembershipAudit(db, {
      id: input.generateId(),
      operatorAccountId: input.operatorAccountId,
      action: 'membership_granted',
      occurredAt: input.now,
      requestId: input.requestId,
      targetAccountId: input.accountId,
      reason: input.reason,
      before,
      after,
      result: outcome.result,
    });
  }

  return {
    changed,
    before,
    after,
    allowedActions: computePlatformMembershipAllowedActions(after),
  };
}

export async function extendPlatformMembership(
  db: Db,
  input: {
    accountId: string;
    accessUntil: string;
    reason: string;
    idempotencyKey: string;
    operatorAccountId: string;
    requestId: string;
    now: string;
    generateId: () => string;
  },
): Promise<PlatformMembershipMutationResult> {
  const account = await findAccountById(db, input.accountId);
  if (!account) {
    throw accountNotFoundError();
  }

  const sourceEventId = `platform:extend:${input.idempotencyKey}`;
  const existingEvent = await findSourceEventBySourceAndEventId(db, 'admin', sourceEventId);
  const existing = await findEntitlementByAccountId(db, input.accountId);
  if (!existing) {
    throw membershipEntitlementNotFoundError();
  }
  if (isProviderSource(existing.source)) {
    throw providerManagedMembershipError();
  }

  if (existingEvent) {
    if (existingEvent.result !== 'applied' && existingEvent.result !== 'replayed') {
      throw membershipOperationNotAllowedError(
        'This idempotency key was previously rejected for membership extend.',
      );
    }
    if (!sameInstant(existing.accessUntil, input.accessUntil)) {
      throw membershipOperationNotAllowedError(
        'Idempotency key reuse must repeat the original extend accessUntil.',
      );
    }
    const after = snapshotOf(existing, input.accountId);
    return {
      changed: false,
      before: after,
      after,
      allowedActions: computePlatformMembershipAllowedActions(after),
    };
  }

  const entitlement = assertAdminActive(existing);
  const before = snapshotOf(entitlement, input.accountId);

  if (
    !entitlement.accessUntil ||
    new Date(input.accessUntil).getTime() <= new Date(entitlement.accessUntil).getTime()
  ) {
    throw membershipOperationNotAllowedError(
      'Extended accessUntil must be strictly later than the current accessUntil.',
    );
  }

  const outcome = await activateMembership(
    db,
    {
      source: 'admin',
      sourceEventId,
      eventType: 'activate',
      accountId: input.accountId,
      effectiveAt: input.now,
      accessUntil: input.accessUntil,
      sourceCustomerId: null,
      sourceSubscriptionId: null,
    },
    {
      processedAt: input.now,
      requestId: input.requestId,
      generateId: input.generateId,
    },
  );

  if (outcome.result === 'rejected' || outcome.result === 'stale') {
    throw membershipOperationNotAllowedError(
      outcome.reason ?? 'Membership extend was rejected by the entitlement transition model.',
    );
  }

  const afterRow = outcome.entitlement ?? (await findEntitlementByAccountId(db, input.accountId));
  const after = snapshotOf(afterRow, input.accountId);
  const changed = outcome.result === 'applied';

  if (changed) {
    await writeMembershipAudit(db, {
      id: input.generateId(),
      operatorAccountId: input.operatorAccountId,
      action: 'membership_extended',
      occurredAt: input.now,
      requestId: input.requestId,
      targetAccountId: input.accountId,
      reason: input.reason,
      before,
      after,
      result: outcome.result,
    });
  }

  return {
    changed,
    before,
    after,
    allowedActions: computePlatformMembershipAllowedActions(after),
  };
}

export async function schedulePlatformMembershipCancellation(
  db: Db,
  input: {
    accountId: string;
    reason: string;
    idempotencyKey: string;
    operatorAccountId: string;
    requestId: string;
    now: string;
    generateId: () => string;
  },
): Promise<PlatformMembershipMutationResult> {
  const account = await findAccountById(db, input.accountId);
  if (!account) {
    throw accountNotFoundError();
  }

  const sourceEventId = `platform:schedule-cancellation:${input.idempotencyKey}`;
  const existingEvent = await findSourceEventBySourceAndEventId(db, 'admin', sourceEventId);
  const existing = await findEntitlementByAccountId(db, input.accountId);
  if (!existing) {
    throw membershipEntitlementNotFoundError();
  }
  if (isProviderSource(existing.source)) {
    throw providerManagedMembershipError();
  }

  if (existingEvent) {
    if (existingEvent.result !== 'applied' && existingEvent.result !== 'replayed') {
      throw membershipOperationNotAllowedError(
        'This idempotency key was previously rejected for membership cancellation scheduling.',
      );
    }
    const after = snapshotOf(existing, input.accountId);
    return {
      changed: false,
      before: after,
      after,
      allowedActions: computePlatformMembershipAllowedActions(after),
    };
  }

  const entitlement = assertAdminActive(existing);
  const before = snapshotOf(entitlement, input.accountId);

  const outcome = await scheduleMembershipCancellation(
    db,
    {
      source: 'admin',
      sourceEventId,
      eventType: 'schedule_cancellation',
      accountId: input.accountId,
      effectiveAt: input.now,
    },
    {
      processedAt: input.now,
      requestId: input.requestId,
      generateId: input.generateId,
    },
  );

  if (outcome.result === 'rejected' || outcome.result === 'stale') {
    throw membershipOperationNotAllowedError(
      outcome.reason ??
        'Membership cancellation schedule was rejected by the entitlement transition model.',
    );
  }

  const afterRow = outcome.entitlement ?? (await findEntitlementByAccountId(db, input.accountId));
  const after = snapshotOf(afterRow, input.accountId);
  const changed = outcome.result === 'applied';

  if (changed) {
    await writeMembershipAudit(db, {
      id: input.generateId(),
      operatorAccountId: input.operatorAccountId,
      action: 'membership_cancellation_scheduled',
      occurredAt: input.now,
      requestId: input.requestId,
      targetAccountId: input.accountId,
      reason: input.reason,
      before,
      after,
      result: outcome.result,
    });
  }

  return {
    changed,
    before,
    after,
    allowedActions: computePlatformMembershipAllowedActions(after),
  };
}
