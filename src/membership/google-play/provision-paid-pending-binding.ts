import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type {
  AccountRow,
  GooglePlayPurchaseLinkRow,
  MembershipEntitlementRow,
} from '../../db/schema.js';
import { appendIdentitySecurityEvent } from '../../identity/repositories/security-events.js';
import { accountNotFoundError } from '../errors.js';
import { hashMembershipTransitionPayload } from '../payload-hash.js';
import {
  insertMembershipEntitlement,
  lockEntitlementByAccountId,
  updateMembershipEntitlement,
} from '../repositories/entitlements.js';
import {
  insertGooglePlayPurchaseLink,
  isGooglePlayPurchaseTokenUniqueViolation,
  lockGooglePlayPurchaseLinkByToken,
} from '../repositories/google-play-purchase-links.js';
import {
  insertMembershipSourceEvent,
  isMembershipSourceEventUniqueViolation,
  lockSourceEventBySourceAndEventId,
} from '../repositories/source-events.js';
import { assertSourceAllowed } from '../source-policy.js';
import type { MembershipTransitionResultKind } from '../types.js';

type Db = Database['db'];

/**
 * Already-verified Google Play purchase facts accepted by the internal
 * paid_pending_binding provisioner.
 *
 * TRUST BOUNDARY: callers must only invoke this after a future server-side
 * Google Play verifier has validated the purchase. This module performs no
 * Google API calls and must never be exposed on an unauthenticated or
 * client-controlled route.
 */
export type VerifiedGooglePlayPurchaseProvisionInput = {
  /** Durable TOWN operation/event id for membership_source_events idempotency. */
  sourceEventId: string;
  accountId: string;
  effectiveAt: string;
  /** Provider current-period / expiry fact copied onto the entitlement access_until. */
  accessUntil: string;
  purchaseToken: string;
  packageName: string;
  subscriptionId: string;
};

export type ProvisionGooglePlayPaidPendingBindingDeps = {
  nodeEnv?: string;
  generateId?: () => string;
  requestId?: string | null;
  processedAt?: string;
};

export type ProvisionGooglePlayPaidPendingBindingOutcome = {
  result: MembershipTransitionResultKind;
  entitlement?: MembershipEntitlementRow;
  purchaseLink?: GooglePlayPurchaseLinkRow;
  reason?: string;
};

function resolveNodeEnv(deps: ProvisionGooglePlayPaidPendingBindingDeps): string {
  return deps.nodeEnv ?? process.env.NODE_ENV ?? 'development';
}

function resolveGenerateId(deps: ProvisionGooglePlayPaidPendingBindingDeps): () => string {
  return deps.generateId ?? randomUUID;
}

function toTransitionPayload(input: VerifiedGooglePlayPurchaseProvisionInput) {
  return {
    source: 'google_play' as const,
    sourceEventId: input.sourceEventId,
    eventType: 'provision_paid_pending_binding' as const,
    accountId: input.accountId,
    effectiveAt: input.effectiveAt,
    accessUntil: input.accessUntil,
    googlePlayPurchaseToken: input.purchaseToken,
    googlePlayPackageName: input.packageName,
    googlePlaySubscriptionId: input.subscriptionId,
  };
}

async function appendProvisionAudit(
  db: Db,
  input: {
    generateId: () => string;
    accountId: string;
    eventType:
      | 'membership_created'
      | 'membership_paid_pending_binding_provisioned'
      | 'membership_event_replayed'
      | 'membership_event_rejected';
    processedAt: string;
    requestId?: string | null;
    previousStatus: string;
    nextStatus: string;
    entitlementVersion: number;
    effectiveAt: string;
    accessUntil: string | null;
  },
): Promise<void> {
  await appendIdentitySecurityEvent(db, {
    id: input.generateId(),
    accountId: input.accountId,
    eventType: input.eventType,
    occurredAt: input.processedAt,
    requestId: input.requestId ?? null,
    metadata: {
      previousStatus: input.previousStatus,
      nextStatus: input.nextStatus,
      entitlementVersion: input.entitlementVersion,
      source: 'google_play',
      eventType: 'provision_paid_pending_binding',
      effectiveAt: input.effectiveAt,
      accessUntilCategory:
        input.accessUntil === null
          ? 'null'
          : new Date(input.accessUntil).getTime() > new Date(input.effectiveAt).getTime()
            ? 'future'
            : 'present_or_past',
    },
  });
}

async function readExistingProvisionOutcome(
  db: Db,
  input: {
    existingPayloadHash: string;
    payloadHash: string;
    accountId: string;
    purchaseToken: string;
    processedAt: string;
    generateId: () => string;
    requestId?: string | null;
    effectiveAt: string;
  },
): Promise<ProvisionGooglePlayPaidPendingBindingOutcome> {
  await db.execute(sql`
    SELECT id
    FROM town.accounts
    WHERE id = ${input.accountId}
    FOR KEY SHARE
  `);
  const entitlement = await lockEntitlementByAccountId(db, input.accountId);
  const purchaseLink = await lockGooglePlayPurchaseLinkByToken(db, input.purchaseToken);

  if (input.existingPayloadHash === input.payloadHash) {
    await appendProvisionAudit(db, {
      generateId: input.generateId,
      accountId: input.accountId,
      eventType: 'membership_event_replayed',
      processedAt: input.processedAt,
      requestId: input.requestId ?? null,
      previousStatus: entitlement?.status ?? 'inactive',
      nextStatus: entitlement?.status ?? 'inactive',
      entitlementVersion: entitlement?.version ?? 0,
      effectiveAt: input.effectiveAt,
      accessUntil: entitlement?.accessUntil ?? null,
    });
    return {
      result: 'replayed',
      ...(entitlement ? { entitlement } : {}),
      ...(purchaseLink ? { purchaseLink } : {}),
    };
  }

  await appendProvisionAudit(db, {
    generateId: input.generateId,
    accountId: input.accountId,
    eventType: 'membership_event_rejected',
    processedAt: input.processedAt,
    requestId: input.requestId ?? null,
    previousStatus: entitlement?.status ?? 'inactive',
    nextStatus: entitlement?.status ?? 'inactive',
    entitlementVersion: entitlement?.version ?? 0,
    effectiveAt: input.effectiveAt,
    accessUntil: entitlement?.accessUntil ?? null,
  });

  return {
    result: 'rejected',
    reason: 'payload_hash_mismatch',
    ...(entitlement ? { entitlement } : {}),
    ...(purchaseLink ? { purchaseLink } : {}),
  };
}

async function runProvisionInTransaction(
  db: Db,
  input: VerifiedGooglePlayPurchaseProvisionInput,
  deps: ProvisionGooglePlayPaidPendingBindingDeps,
): Promise<ProvisionGooglePlayPaidPendingBindingOutcome> {
  const nodeEnv = resolveNodeEnv(deps);
  assertSourceAllowed('google_play', nodeEnv);

  const generateId = resolveGenerateId(deps);
  const processedAt = deps.processedAt ?? new Date().toISOString();
  const transitionPayload = toTransitionPayload(input);
  const payloadHash = hashMembershipTransitionPayload(transitionPayload);

  return db.transaction(async (tx) => {
    const dbTx = tx as unknown as Db;

    const existingEvent = await lockSourceEventBySourceAndEventId(
      dbTx,
      'google_play',
      input.sourceEventId,
    );
    if (existingEvent) {
      return readExistingProvisionOutcome(dbTx, {
        existingPayloadHash: existingEvent.payloadHash,
        payloadHash,
        accountId: input.accountId,
        purchaseToken: input.purchaseToken,
        processedAt,
        generateId,
        requestId: deps.requestId ?? null,
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
    const existingPurchaseLink = await lockGooglePlayPurchaseLinkByToken(
      dbTx,
      input.purchaseToken,
    );

    const reject = async (
      reason: string,
    ): Promise<ProvisionGooglePlayPaidPendingBindingOutcome> => {
      await insertMembershipSourceEvent(dbTx, {
        id: generateId(),
        source: 'google_play',
        sourceEventId: input.sourceEventId,
        eventType: 'provision_paid_pending_binding',
        accountId: input.accountId,
        payloadHash,
        effectiveAt: input.effectiveAt,
        processedAt,
        result: 'rejected',
        createdAt: processedAt,
      });
      await appendProvisionAudit(dbTx, {
        generateId,
        accountId: input.accountId,
        eventType: 'membership_event_rejected',
        processedAt,
        requestId: deps.requestId ?? null,
        previousStatus: entitlement?.status ?? 'inactive',
        nextStatus: entitlement?.status ?? 'inactive',
        entitlementVersion: entitlement?.version ?? 0,
        effectiveAt: input.effectiveAt,
        accessUntil: entitlement?.accessUntil ?? null,
      });
      return {
        result: 'rejected',
        reason,
        ...(entitlement ? { entitlement } : {}),
        ...(existingPurchaseLink ? { purchaseLink: existingPurchaseLink } : {}),
      };
    };

    if (account.status === 'closed') {
      return reject('account_closed');
    }

    if (!input.purchaseToken || input.purchaseToken.length === 0) {
      return reject('purchase_token_required');
    }
    if (!input.packageName || input.packageName.length === 0) {
      return reject('package_name_required');
    }
    if (!input.subscriptionId || input.subscriptionId.length === 0) {
      return reject('subscription_id_required');
    }
    if (!input.accessUntil) {
      return reject('access_until_required');
    }
    if (new Date(input.accessUntil).getTime() <= new Date(input.effectiveAt).getTime()) {
      return reject('access_until_must_exceed_effective_at');
    }

    // One purchase token correlates to exactly one account/entitlement.
    // Exact source-event replays are handled above via membership_source_events.
    if (existingPurchaseLink) {
      return reject('purchase_token_already_correlated');
    }

    const previousStatus = entitlement?.status ?? 'inactive';
    if (
      entitlement &&
      (entitlement.status === 'active' ||
        entitlement.status === 'cancelling' ||
        entitlement.status === 'paid_pending_binding')
    ) {
      return reject('invalid_status_for_provision_paid_pending_binding');
    }

    const nextVersion = (entitlement?.version ?? 0) + 1;
    const mutation = {
      status: 'paid_pending_binding' as const,
      accessUntil: input.accessUntil,
      cancelAtPeriodEnd: false,
      source: 'google_play' as const,
      sourceCustomerId: null,
      sourceSubscriptionId: null,
      activatedAt: null,
      cancellationRequestedAt: null,
      expiredAt: null,
      version: nextVersion,
    };

    const isCreation = entitlement === null;
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

    let purchaseLink: GooglePlayPurchaseLinkRow;
    try {
      purchaseLink = await insertGooglePlayPurchaseLink(dbTx, {
        id: generateId(),
        accountId: input.accountId,
        entitlementId: entitlement.id,
        purchaseToken: input.purchaseToken,
        packageName: input.packageName,
        subscriptionId: input.subscriptionId,
        expiryTime: input.accessUntil,
        createdAt: processedAt,
        updatedAt: processedAt,
      });
    } catch (error) {
      if (isGooglePlayPurchaseTokenUniqueViolation(error)) {
        // Concurrent correlator won; abort the whole transaction so entitlement
        // provisioning cannot commit without the matching purchase link.
        throw error;
      }
      throw error;
    }

    await insertMembershipSourceEvent(dbTx, {
      id: generateId(),
      source: 'google_play',
      sourceEventId: input.sourceEventId,
      eventType: 'provision_paid_pending_binding',
      accountId: input.accountId,
      payloadHash,
      effectiveAt: input.effectiveAt,
      processedAt,
      result: 'applied',
      createdAt: processedAt,
    });

    if (isCreation) {
      await appendProvisionAudit(dbTx, {
        generateId,
        accountId: input.accountId,
        eventType: 'membership_created',
        processedAt,
        requestId: deps.requestId ?? null,
        previousStatus,
        nextStatus: entitlement.status,
        entitlementVersion: entitlement.version,
        effectiveAt: input.effectiveAt,
        accessUntil: entitlement.accessUntil,
      });
    }

    await appendProvisionAudit(dbTx, {
      generateId,
      accountId: input.accountId,
      eventType: 'membership_paid_pending_binding_provisioned',
      processedAt,
      requestId: deps.requestId ?? null,
      previousStatus,
      nextStatus: entitlement.status,
      entitlementVersion: entitlement.version,
      effectiveAt: input.effectiveAt,
      accessUntil: entitlement.accessUntil,
    });

    return {
      result: 'applied',
      entitlement,
      purchaseLink,
    };
  });
}

async function findAndCompareAfterRace(
  db: Db,
  input: VerifiedGooglePlayPurchaseProvisionInput,
  deps: ProvisionGooglePlayPaidPendingBindingDeps,
): Promise<ProvisionGooglePlayPaidPendingBindingOutcome> {
  const generateId = resolveGenerateId(deps);
  const processedAt = deps.processedAt ?? new Date().toISOString();
  const payloadHash = hashMembershipTransitionPayload(toTransitionPayload(input));

  return db.transaction(async (tx) => {
    const dbTx = tx as unknown as Db;
    const existingEvent = await lockSourceEventBySourceAndEventId(
      dbTx,
      'google_play',
      input.sourceEventId,
    );
    if (!existingEvent) {
      throw new Error('Google Play provision source event race recovery failed');
    }
    return readExistingProvisionOutcome(dbTx, {
      existingPayloadHash: existingEvent.payloadHash,
      payloadHash,
      accountId: input.accountId,
      purchaseToken: input.purchaseToken,
      processedAt,
      generateId,
      requestId: deps.requestId ?? null,
      effectiveAt: input.effectiveAt,
    });
  });
}

function isTransientPostgresConflict(error: unknown): boolean {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
  const candidates: unknown[] = [error, cause];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      const code = (candidate as { code?: unknown }).code;
      if (code === '40P01' || code === '40001') {
        return true;
      }
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  const causeMessage = cause?.message ?? '';
  return /deadlock detected|could not serialize access/i.test(`${message}${causeMessage}`);
}

const MAX_PROVISION_RETRIES = 5;

/**
 * Internal-only Google Play paid_pending_binding provisioner.
 *
 * Accepts an already-verified purchase result and durably correlates it to exactly
 * one TOWN account/entitlement in status paid_pending_binding. Never produces
 * active membership and never grants civic participation.
 */
export async function provisionGooglePlayPaidPendingBinding(
  db: Db,
  input: VerifiedGooglePlayPurchaseProvisionInput,
  deps: ProvisionGooglePlayPaidPendingBindingDeps = {},
): Promise<ProvisionGooglePlayPaidPendingBindingOutcome> {
  for (let attempt = 0; attempt <= MAX_PROVISION_RETRIES; attempt += 1) {
    try {
      return await runProvisionInTransaction(db, input, deps);
    } catch (error) {
      if (isMembershipSourceEventUniqueViolation(error)) {
        return await findAndCompareAfterRace(db, input, deps);
      }
      if (isGooglePlayPurchaseTokenUniqueViolation(error)) {
        // Another transaction correlated this token; surface a rejected outcome
        // only when the competing write committed. Re-read outside the aborted TX.
        const existing = await findCommittedTokenConflict(db, input);
        if (existing) {
          return existing;
        }
      }
      if (isTransientPostgresConflict(error) && attempt < MAX_PROVISION_RETRIES) {
        const delayMs = Math.floor(Math.random() * 25) + 5 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw error;
    }
  }
  throw new Error('provisionGooglePlayPaidPendingBinding exhausted retry budget without result');
}

async function findCommittedTokenConflict(
  db: Db,
  input: VerifiedGooglePlayPurchaseProvisionInput,
): Promise<ProvisionGooglePlayPaidPendingBindingOutcome | null> {
  return db.transaction(async (tx) => {
    const dbTx = tx as unknown as Db;
    const link = await lockGooglePlayPurchaseLinkByToken(dbTx, input.purchaseToken);
    if (!link) {
      return null;
    }
    const entitlement = await lockEntitlementByAccountId(dbTx, input.accountId);
    return {
      result: 'rejected',
      reason: 'purchase_token_already_correlated',
      ...(entitlement ? { entitlement } : {}),
      purchaseLink: link,
    };
  });
}
