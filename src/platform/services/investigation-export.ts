import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';
import { toIsoTimestamp } from '../../lib/timestamps.js';
import { listPlatformAuditEvents } from '../repositories/audit.js';
import {
  getPlatformAccountDetail,
  getPlatformAccountEmails,
  getPlatformAccountPayments,
} from '../repositories/inventory.js';

type Db = NodePgDatabase<typeof schema>;

export const PLATFORM_INVESTIGATION_EXPORT_AUDIT_LIMIT = 50;

export type PlatformInvestigationExportPack = {
  readonly generatedAt: string;
  readonly accountId: string;
  readonly account: {
    readonly accountId: string;
    readonly status:
      'pending_email' | 'pending_password' | 'pending_passkey' | 'active' | 'suspended' | 'closed';
    readonly isOwner: boolean;
    readonly email: string | null;
    readonly communitySlug: string | null;
    readonly membershipStatus: string | null;
    readonly suspendedAt: string | null;
    readonly accountReadyAt: string | null;
    readonly closedAt: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly emails: {
    readonly emails: {
      readonly id: string;
      readonly emailOriginal: string;
      readonly emailNormalized: string;
      readonly isPrimary: boolean;
      readonly verifiedAt: string | null;
      readonly revokedAt: string | null;
      readonly createdAt: string;
    }[];
    readonly challenges: {
      readonly id: string;
      readonly emailNormalized: string;
      readonly purpose: string;
      readonly createdAt: string;
      readonly expiresAt: string;
      readonly consumedAt: string | null;
      readonly revokedAt: string | null;
      readonly attemptCount: number;
    }[];
  };
  readonly payments: {
    readonly entitlement: {
      readonly status: string;
      readonly source: string;
      readonly accessUntil: string | null;
      readonly cancelAtPeriodEnd: boolean;
      readonly activatedAt: string | null;
      readonly cancellationRequestedAt: string | null;
      readonly expiredAt: string | null;
      readonly version: number;
      readonly updatedAt: string;
    } | null;
    readonly stripeCustomer:
      | {
          readonly linked: true;
          readonly billingReference: string;
          readonly createdAt: string;
          readonly updatedAt: string;
        }
      | { readonly linked: false };
    readonly checkoutAttempts: {
      readonly id: string;
      readonly status: string;
      readonly hasStripeSession: boolean;
      readonly createdAt: string;
      readonly expiresAt: string;
      readonly completedAt: string | null;
    }[];
  };
  readonly platformAudit: {
    readonly events: {
      readonly id: string;
      readonly operatorAccountId: string;
      readonly action: string;
      readonly targetAccountId: string | null;
      readonly targetSignalId: string | null;
      readonly requestId: string | null;
      readonly metadata: Record<string, unknown> | null;
      readonly occurredAt: string;
    }[];
  };
};

/**
 * Bounded support/investigation pack for one account.
 * Reuses existing inventory helpers — no Stripe provider IDs, secrets, or codes.
 */
export async function buildPlatformInvestigationExport(
  db: Db,
  input: { accountId: string; generatedAt: string },
): Promise<PlatformInvestigationExportPack | null> {
  const detail = await getPlatformAccountDetail(db, input.accountId);
  if (!detail) return null;

  const [emails, payments, auditEvents] = await Promise.all([
    getPlatformAccountEmails(db, input.accountId),
    getPlatformAccountPayments(db, input.accountId),
    listPlatformAuditEvents(db, {
      limit: PLATFORM_INVESTIGATION_EXPORT_AUDIT_LIMIT,
      targetAccountId: input.accountId,
    }),
  ]);

  return {
    generatedAt: input.generatedAt,
    accountId: detail.accountId,
    account: {
      accountId: detail.accountId,
      status: detail.status as PlatformInvestigationExportPack['account']['status'],
      isOwner: detail.isOwner,
      email: detail.email,
      communitySlug: detail.communitySlug,
      membershipStatus: detail.membershipStatus,
      suspendedAt: detail.suspendedAt === null ? null : toIsoTimestamp(detail.suspendedAt),
      accountReadyAt: detail.accountReadyAt === null ? null : toIsoTimestamp(detail.accountReadyAt),
      closedAt: detail.closedAt === null ? null : toIsoTimestamp(detail.closedAt),
      createdAt: toIsoTimestamp(detail.createdAt),
      updatedAt: toIsoTimestamp(detail.updatedAt),
    },
    emails: {
      emails: emails.emails.map((row) => ({
        id: row.id,
        emailOriginal: row.emailOriginal,
        emailNormalized: row.emailNormalized,
        isPrimary: row.isPrimary,
        verifiedAt: row.verifiedAt === null ? null : toIsoTimestamp(row.verifiedAt),
        revokedAt: row.revokedAt === null ? null : toIsoTimestamp(row.revokedAt),
        createdAt: toIsoTimestamp(row.createdAt),
      })),
      challenges: emails.challenges.map((row) => ({
        id: row.id,
        emailNormalized: row.emailNormalized,
        purpose: row.purpose,
        createdAt: toIsoTimestamp(row.createdAt),
        expiresAt: toIsoTimestamp(row.expiresAt),
        consumedAt: row.consumedAt === null ? null : toIsoTimestamp(row.consumedAt),
        revokedAt: row.revokedAt === null ? null : toIsoTimestamp(row.revokedAt),
        attemptCount: row.attemptCount,
      })),
    },
    payments: {
      entitlement: payments.entitlement
        ? {
            status: payments.entitlement.status,
            source: payments.entitlement.source,
            accessUntil:
              payments.entitlement.accessUntil === null
                ? null
                : toIsoTimestamp(payments.entitlement.accessUntil),
            cancelAtPeriodEnd: payments.entitlement.cancelAtPeriodEnd,
            activatedAt:
              payments.entitlement.activatedAt === null
                ? null
                : toIsoTimestamp(payments.entitlement.activatedAt),
            cancellationRequestedAt:
              payments.entitlement.cancellationRequestedAt === null
                ? null
                : toIsoTimestamp(payments.entitlement.cancellationRequestedAt),
            expiredAt:
              payments.entitlement.expiredAt === null
                ? null
                : toIsoTimestamp(payments.entitlement.expiredAt),
            version: payments.entitlement.version,
            updatedAt: toIsoTimestamp(payments.entitlement.updatedAt),
          }
        : null,
      stripeCustomer: payments.stripeCustomer.linked
        ? {
            linked: true as const,
            billingReference: payments.stripeCustomer.billingReference,
            createdAt: toIsoTimestamp(payments.stripeCustomer.createdAt),
            updatedAt: toIsoTimestamp(payments.stripeCustomer.updatedAt),
          }
        : { linked: false as const },
      checkoutAttempts: payments.checkoutAttempts.map((row) => ({
        id: row.id,
        status: row.status,
        hasStripeSession: row.hasStripeSession,
        createdAt: toIsoTimestamp(row.createdAt),
        expiresAt: toIsoTimestamp(row.expiresAt),
        completedAt: row.completedAt === null ? null : toIsoTimestamp(row.completedAt),
      })),
    },
    platformAudit: {
      events: auditEvents.map((event) => ({
        id: event.id,
        operatorAccountId: event.operatorAccountId,
        action: event.action,
        targetAccountId: event.targetAccountId,
        targetSignalId: event.targetSignalId,
        requestId: event.requestId,
        metadata: (event.metadata as Record<string, unknown> | null) ?? null,
        occurredAt: toIsoTimestamp(event.occurredAt),
      })),
    },
  };
}
