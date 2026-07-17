import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type {
  AccountRow,
  IdentitySecurityEventType,
  MembershipEntitlementRow,
  MembershipSource,
  MembershipSourceEventType,
} from '../../db/schema.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import { accountNotFoundError } from '../errors.js';
import {
  hashMembershipTransitionPayload,
  type MembershipTransitionPayloadInput,
} from '../payload-hash.js';
import { assertSourceAllowed } from '../source-policy.js';
import type { AccessUntilCategory, MembershipTransitionResultKind } from '../types.js';
import {
  insertMembershipEntitlement,
  lockEntitlementByAccountId,
  updateMembershipEntitlement,
} from '../repositories/entitlements.js';
import {
  insertMembershipSourceEvent,
  isMembershipSourceEventUniqueViolation,
  lockSourceEventBySourceAndEventId,
} from '../repositories/source-events.js';

type Db = Database['db'];

export type MembershipTransitionInput = MembershipTransitionPayloadInput;

export type MembershipTransitionDeps = {
  nodeEnv?: string;
  generateId?: () => string;
  requestId?: string | null;
  processedAt?: string;
};

export type MembershipTransitionOutcome = {
  result: MembershipTransitionResultKind;
  entitlement?: MembershipEntitlementRow;
  reason?: string;
};

export type TransitionContext = {
  account: AccountRow;
  entitlement: MembershipEntitlementRow | null;
  input: MembershipTransitionInput;
  payloadHash: string;
  processedAt: string;
};

export type TransitionValidation =
  | { kind: 'apply' }
  | { kind: 'reject'; reason: string }
  | { kind: 'stale'; reason: string };

export type TransitionLogic = {
  eventType: MembershipSourceEventType;
  validate: (ctx: TransitionContext) => TransitionValidation;
  apply: (
    ctx: TransitionContext,
  ) => Omit<
    Parameters<typeof updateMembershipEntitlement>[1],
    'id' | 'updatedAt' | 'version'
  > & { version: number };
  appliedAuditEventType: IdentitySecurityEventType;
  replayedAuditEventType?: IdentitySecurityEventType;
  rejectedAuditEventType?: IdentitySecurityEventType;
  isCreation?: (ctx: TransitionContext) => boolean;
};

function resolveNodeEnv(deps: MembershipTransitionDeps): string {
  return deps.nodeEnv ?? process.env.NODE_ENV ?? 'development';
}

function resolveGenerateId(deps: MembershipTransitionDeps): () => string {
  return deps.generateId ?? randomUUID;
}

export function computeAccessUntilCategory(
  accessUntil: string | null,
  effectiveAt: string,
): AccessUntilCategory {
  if (accessUntil === null) {
    return 'null';
  }
  if (new Date(accessUntil).getTime() > new Date(effectiveAt).getTime()) {
    return 'future';
  }
  return 'present_or_past';
}

function buildAuditMetadata(input: {
  previousStatus: string;
  nextStatus: string;
  entitlementVersion: number;
  source: MembershipSource;
  eventType: MembershipSourceEventType;
  effectiveAt: string;
  accessUntil: string | null;
}): Record<string, string | number | boolean | null> {
  return {
    previousStatus: input.previousStatus,
    nextStatus: input.nextStatus,
    entitlementVersion: input.entitlementVersion,
    source: input.source,
    eventType: input.eventType,
    effectiveAt: input.effectiveAt,
    accessUntilCategory: computeAccessUntilCategory(input.accessUntil, input.effectiveAt),
  };
}

async function appendTransitionAuditEvent(
  db: Db,
  input: {
    generateId: () => string;
    accountId: string;
    eventType: IdentitySecurityEventType;
    processedAt: string;
    requestId?: string | null;
    metadata: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  await appendIdentitySecurityEvent(db, {
    id: input.generateId(),
    accountId: input.accountId,
    eventType: input.eventType,
    occurredAt: input.processedAt,
    requestId: input.requestId ?? null,
    metadata: input.metadata,
  });
}

async function readExistingOutcome(
  db: Db,
  input: {
    existingPayloadHash: string;
    payloadHash: string;
    accountId: string;
    logic: TransitionLogic;
    processedAt: string;
    generateId: () => string;
    requestId?: string | null;
    source: MembershipSource;
    eventType: MembershipSourceEventType;
    effectiveAt: string;
  },
): Promise<MembershipTransitionOutcome> {
  const entitlement = await lockEntitlementByAccountId(db, input.accountId);
  if (input.existingPayloadHash === input.payloadHash) {
    if (input.logic.replayedAuditEventType) {
      await appendTransitionAuditEvent(db, {
        generateId: input.generateId,
        accountId: input.accountId,
        eventType: input.logic.replayedAuditEventType,
        processedAt: input.processedAt,
        requestId: input.requestId ?? null,
        metadata: buildAuditMetadata({
          previousStatus: entitlement?.status ?? 'inactive',
          nextStatus: entitlement?.status ?? 'inactive',
          entitlementVersion: entitlement?.version ?? 0,
          source: input.source,
          eventType: input.eventType,
          effectiveAt: input.effectiveAt,
          accessUntil: entitlement?.accessUntil ?? null,
        }),
      });
    }
    return {
      result: 'replayed',
      ...(entitlement ? { entitlement } : {}),
    };
  }

  if (input.logic.rejectedAuditEventType) {
    await appendTransitionAuditEvent(db, {
      generateId: input.generateId,
      accountId: input.accountId,
      eventType: input.logic.rejectedAuditEventType,
      processedAt: input.processedAt,
      requestId: input.requestId ?? null,
      metadata: buildAuditMetadata({
        previousStatus: entitlement?.status ?? 'inactive',
        nextStatus: entitlement?.status ?? 'inactive',
        entitlementVersion: entitlement?.version ?? 0,
        source: input.source,
        eventType: input.eventType,
        effectiveAt: input.effectiveAt,
        accessUntil: entitlement?.accessUntil ?? null,
      }),
    });
  }

  return {
    result: 'rejected',
    reason: 'payload_hash_mismatch',
    ...(entitlement ? { entitlement } : {}),
  };
}

async function runTransitionInTransaction(
  db: Db,
  input: MembershipTransitionInput,
  logic: TransitionLogic,
  deps: MembershipTransitionDeps,
): Promise<MembershipTransitionOutcome> {
  const nodeEnv = resolveNodeEnv(deps);
  assertSourceAllowed(input.source, nodeEnv);

  const generateId = resolveGenerateId(deps);
  const processedAt = deps.processedAt ?? new Date().toISOString();
  const payloadHash = hashMembershipTransitionPayload(input);

  if (input.eventType !== logic.eventType) {
    return { result: 'rejected', reason: 'event_type_mismatch' };
  }

  return db.transaction(async (tx) => {
    const dbTx = tx as unknown as Db;

    const existingEvent = await lockSourceEventBySourceAndEventId(
      dbTx,
      input.source,
      input.sourceEventId,
    );
    if (existingEvent) {
      return readExistingOutcome(dbTx, {
        existingPayloadHash: existingEvent.payloadHash,
        payloadHash,
        accountId: input.accountId,
        logic,
        processedAt,
        generateId,
        requestId: deps.requestId ?? null,
        source: input.source,
        eventType: input.eventType,
        effectiveAt: input.effectiveAt,
      });
    }

    const accountRows = await tx.execute<{
      id: string;
      status: string;
      webauthn_user_handle: unknown;
      account_ready_at: string | null;
      recovery_completed_at: string | null;
      suspended_at: string | null;
      closed_at: string | null;
      created_at: string;
      updated_at: string;
    }>(sql`
      SELECT id, status, webauthn_user_handle, account_ready_at, recovery_completed_at,
             suspended_at, closed_at, created_at, updated_at
      FROM town.accounts
      WHERE id = ${input.accountId}
      FOR UPDATE
    `);
    const accountRow = accountRows.rows[0];
    if (!accountRow) {
      throw accountNotFoundError();
    }

    const account: AccountRow = {
      id: accountRow.id,
      status: accountRow.status,
      webauthnUserHandle: accountRow.webauthn_user_handle as AccountRow['webauthnUserHandle'],
      accountReadyAt: accountRow.account_ready_at,
      recoveryCompletedAt: accountRow.recovery_completed_at,
      suspendedAt: accountRow.suspended_at,
      closedAt: accountRow.closed_at,
      createdAt: accountRow.created_at,
      updatedAt: accountRow.updated_at,
    };

    let entitlement = await lockEntitlementByAccountId(dbTx, input.accountId);
    const ctx: TransitionContext = {
      account,
      entitlement,
      input,
      payloadHash,
      processedAt,
    };

    const validation = logic.validate(ctx);
    const previousStatus = entitlement?.status ?? 'inactive';

    if (validation.kind === 'reject') {
      await insertMembershipSourceEvent(dbTx, {
        id: generateId(),
        source: input.source,
        sourceEventId: input.sourceEventId,
        eventType: input.eventType,
        accountId: input.accountId,
        payloadHash,
        effectiveAt: input.effectiveAt,
        processedAt,
        result: 'rejected',
        createdAt: processedAt,
      });

      if (logic.rejectedAuditEventType) {
        await appendTransitionAuditEvent(dbTx, {
          generateId,
          accountId: input.accountId,
          eventType: logic.rejectedAuditEventType,
          processedAt,
          requestId: deps.requestId ?? null,
          metadata: buildAuditMetadata({
            previousStatus,
            nextStatus: previousStatus,
            entitlementVersion: entitlement?.version ?? 0,
            source: input.source,
            eventType: input.eventType,
            effectiveAt: input.effectiveAt,
            accessUntil: entitlement?.accessUntil ?? null,
          }),
        });
      }

      return {
        result: 'rejected',
        reason: validation.reason,
        ...(entitlement ? { entitlement } : {}),
      };
    }

    if (validation.kind === 'stale') {
      await insertMembershipSourceEvent(dbTx, {
        id: generateId(),
        source: input.source,
        sourceEventId: input.sourceEventId,
        eventType: input.eventType,
        accountId: input.accountId,
        payloadHash,
        effectiveAt: input.effectiveAt,
        processedAt,
        result: 'stale',
        createdAt: processedAt,
      });

      return {
        result: 'stale',
        reason: validation.reason,
        ...(entitlement ? { entitlement } : {}),
      };
    }

    const mutation = logic.apply(ctx);
    const isCreation = logic.isCreation?.(ctx) ?? entitlement === null;

    if (entitlement === null) {
      entitlement = await insertMembershipEntitlement(dbTx, {
        id: generateId(),
        accountId: input.accountId,
        status: mutation.status,
        accessUntil: mutation.accessUntil,
        cancelAtPeriodEnd: mutation.cancelAtPeriodEnd,
        source: mutation.source,
        sourceCustomerId: mutation.sourceCustomerId,
        sourceSubscriptionId: mutation.sourceSubscriptionId,
        activatedAt: mutation.activatedAt,
        cancellationRequestedAt: mutation.cancellationRequestedAt,
        expiredAt: mutation.expiredAt,
        createdAt: processedAt,
        updatedAt: processedAt,
        version: mutation.version,
      });
    } else {
      entitlement = await updateMembershipEntitlement(dbTx, {
        id: entitlement.id,
        status: mutation.status,
        accessUntil: mutation.accessUntil,
        cancelAtPeriodEnd: mutation.cancelAtPeriodEnd,
        source: mutation.source,
        sourceCustomerId: mutation.sourceCustomerId,
        sourceSubscriptionId: mutation.sourceSubscriptionId,
        activatedAt: mutation.activatedAt,
        cancellationRequestedAt: mutation.cancellationRequestedAt,
        expiredAt: mutation.expiredAt,
        updatedAt: processedAt,
        version: mutation.version,
      });
    }

    await insertMembershipSourceEvent(dbTx, {
      id: generateId(),
      source: input.source,
      sourceEventId: input.sourceEventId,
      eventType: input.eventType,
      accountId: input.accountId,
      payloadHash,
      effectiveAt: input.effectiveAt,
      processedAt,
      result: 'applied',
      createdAt: processedAt,
    });

    if (isCreation) {
      await appendTransitionAuditEvent(dbTx, {
        generateId,
        accountId: input.accountId,
        eventType: 'membership_created',
        processedAt,
        requestId: deps.requestId ?? null,
        metadata: buildAuditMetadata({
          previousStatus,
          nextStatus: entitlement.status,
          entitlementVersion: entitlement.version,
          source: input.source,
          eventType: input.eventType,
          effectiveAt: input.effectiveAt,
          accessUntil: entitlement.accessUntil,
        }),
      });
    }

    await appendTransitionAuditEvent(dbTx, {
      generateId,
      accountId: input.accountId,
      eventType: logic.appliedAuditEventType,
      processedAt,
      requestId: deps.requestId ?? null,
      metadata: buildAuditMetadata({
        previousStatus,
        nextStatus: entitlement.status,
        entitlementVersion: entitlement.version,
        source: input.source,
        eventType: input.eventType,
        effectiveAt: input.effectiveAt,
        accessUntil: entitlement.accessUntil,
      }),
    });

    return {
      result: 'applied',
      entitlement,
    };
  });
}

export async function executeMembershipTransition(
  db: Db,
  input: MembershipTransitionInput,
  logic: TransitionLogic,
  deps: MembershipTransitionDeps = {},
): Promise<MembershipTransitionOutcome> {
  try {
    return await runTransitionInTransaction(db, input, logic, deps);
  } catch (error) {
    if (!isMembershipSourceEventUniqueViolation(error)) {
      throw error;
    }

    const existing = await findAndCompareAfterRace(db, input, logic, deps);
    return existing;
  }
}

async function findAndCompareAfterRace(
  db: Db,
  input: MembershipTransitionInput,
  logic: TransitionLogic,
  deps: MembershipTransitionDeps,
): Promise<MembershipTransitionOutcome> {
  const generateId = resolveGenerateId(deps);
  const processedAt = deps.processedAt ?? new Date().toISOString();
  const payloadHash = hashMembershipTransitionPayload(input);

  return db.transaction(async (tx) => {
    const dbTx = tx as unknown as Db;
    const existingEvent = await lockSourceEventBySourceAndEventId(
      dbTx,
      input.source,
      input.sourceEventId,
    );
    if (!existingEvent) {
      throw new Error('Membership source event race recovery failed');
    }

    return readExistingOutcome(dbTx, {
      existingPayloadHash: existingEvent.payloadHash,
      payloadHash,
      accountId: input.accountId,
      logic,
      processedAt,
      generateId,
      requestId: deps.requestId ?? null,
      source: input.source,
      eventType: input.eventType,
      effectiveAt: input.effectiveAt,
    });
  });
}
