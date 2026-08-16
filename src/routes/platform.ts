import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env.js';
import {
  hideCivicDeliberationContribution,
  hideCivicProposal,
  hideCivicVerificationEvidence,
  unhideCivicDeliberationContribution,
  unhideCivicProposal,
  unhideCivicVerificationEvidence,
} from '../db/repositories/civic-content-moderation.js';
import {
  findCivicMandateContestationById,
  listPendingCivicMandateContestations,
  resolveCivicMandateContestation,
} from '../db/repositories/civic-contestations.js';
import {
  findCivicVerificationDisputeResolution,
  listEscalatedUnresolvedCivicVerificationDisputes,
  resolveCivicVerificationDispute,
} from '../db/repositories/civic-verification.js';
import {
  hideDiscussionContribution,
  unhideDiscussionContribution,
} from '../db/repositories/discussion-contribution-moderation.js';
import {
  rejectSignalSubmission,
  restoreSignalSubmission,
} from '../db/repositories/signal-submission-moderation.js';
import { hideSignal, unhideSignal } from '../db/repositories/signals.js';
import type { AccountRow, PlatformAuditAction } from '../db/schema.js';
import { actors } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { revokeAllAccountSessions } from '../ceremony/repositories/account-sessions.js';
import {
  findAccountById,
  lockAccountById,
  transitionAccountState,
} from '../identity/repositories/accounts.js';
import { appendIdentitySecurityEvent } from '../identity/repositories/security-events.js';
import { normalizeEmail } from '../identity/email-normalize.js';
import { toIsoTimestamp } from '../lib/timestamps.js';
import { buildIdentityFromEnv } from '../ops/build-identity.js';
import { resolvePlatformOperator, requireOperatorCapability } from '../platform/auth.js';
import {
  appendPlatformAuditEvent,
  listPlatformAuditEvents,
} from '../platform/repositories/audit.js';
import {
  getPlatformAccountDetail,
  getPlatformAccountEmails,
  getPlatformAccountPayments,
  getPlatformStatusCounts,
  getPlatformSubmissionDetail,
  listPlatformAccounts,
  listPlatformCommunities,
  listPlatformDiscussions,
  listPlatformMemberships,
  listPlatformSignals,
  listPlatformSubmissions,
} from '../platform/repositories/inventory.js';
import {
  listActivePlatformOperators,
  revokePlatformOperator,
  upsertPlatformOperator,
} from '../platform/repositories/operators.js';
import { isPlatformOperatorRole } from '../platform/roles.js';
import {
  computePlatformMembershipAllowedActions,
  extendPlatformMembership,
  grantPlatformMembership,
  schedulePlatformMembershipCancellation,
} from '../platform/services/memberships.js';
import { collectOperationalComponents } from '../platform/services/status-checks.js';
import { recordUptimeObservation } from '../platform/services/record-uptime-observation.js';
import {
  assessBackupComponent,
  readPlatformBackupConfig,
  sanitizeBackupNote,
} from '../platform/services/backup.js';
import {
  assessRestoreComponent,
  readPlatformRestoreDrillConfig,
  sanitizeRestoreDrillNote,
} from '../platform/services/restore-drill.js';
import { buildPlatformInvestigationExport } from '../platform/services/investigation-export.js';
import { listPlatformTechnicalErrors } from '../platform/repositories/technical-errors.js';
import {
  acknowledgePlatformAlert,
  countOpenPlatformAlerts,
  listPlatformAlerts,
} from '../platform/repositories/alerts.js';
import {
  appendPlatformBackupVerification,
  getLatestPlatformBackupVerification,
  listPlatformBackupVerifications,
} from '../platform/repositories/backup-verifications.js';
import {
  appendPlatformRestoreDrillAttestation,
  getLatestPlatformRestoreDrillAttestation,
  listPlatformRestoreDrillAttestations,
} from '../platform/repositories/restore-drill-attestations.js';
import { summarizePlatformUptimeSamples } from '../platform/repositories/uptime-samples.js';
import {
  PlatformCivicContentHideBodySchema,
  PlatformCivicContentIdParamsSchema,
  PlatformCivicContestationIdParamsSchema,
  PlatformCivicContestationResolveBodySchema,
  PlatformCivicModerationRouteResponses,
  PlatformCivicVerificationDisputeProcessIdParamsSchema,
  PlatformCivicVerificationDisputeResolveBodySchema,
} from '../schemas/civic-moderation.js';
import { DomainErrorResponseSchema } from '../schemas/error.js';
import {
  PlatformAccountActionResponseSchema,
  PlatformAccountDetailResponseSchema,
  PlatformAccountEmailsResponseSchema,
  PlatformAccountIdParamsSchema,
  PlatformAccountPaymentsResponseSchema,
  PlatformAccountsQuerySchema,
  PlatformAccountsResponseSchema,
  PlatformAccountSuspendBodySchema,
  PlatformAlertActionResponseSchema,
  PlatformAlertIdParamsSchema,
  PlatformAlertsQuerySchema,
  PlatformAlertsResponseSchema,
  PlatformBackupResponseSchema,
  PlatformBackupVerifyBodySchema,
  PlatformBackupVerifyResponseSchema,
  PlatformInvestigationExportResponseSchema,
  PlatformRestoreAttestBodySchema,
  PlatformRestoreAttestResponseSchema,
  PlatformRestoreResponseSchema,
  PlatformAuditQuerySchema,
  PlatformAuditResponseSchema,
  PlatformCommunitiesResponseSchema,
  PlatformDiscussionActionResponseSchema,
  PlatformDiscussionContributionIdParamsSchema,
  PlatformDiscussionHideBodySchema,
  PlatformDiscussionsQuerySchema,
  PlatformDiscussionsResponseSchema,
  PlatformMembershipActionResponseSchema,
  PlatformMembershipExtendBodySchema,
  PlatformMembershipGrantBodySchema,
  PlatformMembershipScheduleCancellationBodySchema,
  PlatformMembershipsQuerySchema,
  PlatformMembershipsResponseSchema,
  PlatformOperatorActionResponseSchema,
  PlatformOperatorGrantBodySchema,
  PlatformOperatorsResponseSchema,
  PlatformSessionResponseSchema,
  PlatformSignalActionResponseSchema,
  PlatformSignalHideBodySchema,
  PlatformSignalIdParamsSchema,
  PlatformSignalsQuerySchema,
  PlatformSignalsResponseSchema,
  PlatformStatusResponseSchema,
  PlatformTechnicalErrorsQuerySchema,
  PlatformTechnicalErrorsResponseSchema,
  PlatformUptimeQuerySchema,
  PlatformUptimeResponseSchema,
  PlatformSubmissionActionResponseSchema,
  PlatformSubmissionDetailResponseSchema,
  PlatformSubmissionIdParamsSchema,
  PlatformSubmissionRejectBodySchema,
  PlatformSubmissionsQuerySchema,
  PlatformSubmissionsResponseSchema,
} from '../schemas/platform.js';
import { accountNotFoundError } from '../errors/app-error.js';

function submissionAllowedActions(status: string): ('reject' | 'restore')[] {
  if (status === 'pending_review') return ['reject'];
  if (status === 'rejected') return ['restore'];
  return [];
}

function discussionAllowedActions(hidden: boolean): ('hide' | 'unhide')[] {
  return hidden ? ['unhide'] : ['hide'];
}

export type PlatformRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
};

/**
 * Separate platform-operator administration plane under `/v1/platform/*`.
 *
 * Authz: active session AND active `platform_operators` row (never `accounts.is_owner`).
 * Unauthorized callers receive generic 404 so the surface is not revealed.
 * Mutating actions write `platform_audit_events` and, where applicable, identity audits.
 */
export const platformRoutes: FastifyPluginCallbackTypebox<PlatformRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { env } = options;
  const now = () => (options.now ?? (() => new Date().toISOString()))();
  const generateId = options.generateId ?? (() => randomUUID());
  const identity = buildIdentityFromEnv(env);

  async function requireOperator(
    request: Parameters<typeof resolvePlatformOperator>[2],
    capability: Parameters<typeof requireOperatorCapability>[1],
  ) {
    const operator = await resolvePlatformOperator(app.database.db, env, request, now);
    if (!operator || !requireOperatorCapability(operator, capability)) {
      return null;
    }
    return operator;
  }

  async function audit(
    operatorAccountId: string,
    action: PlatformAuditAction,
    requestId: string,
    extra?: {
      targetAccountId?: string | null;
      targetSignalId?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    await appendPlatformAuditEvent(app.database.db, {
      id: generateId(),
      operatorAccountId,
      action,
      occurredAt: now(),
      requestId,
      targetAccountId: extra?.targetAccountId ?? null,
      targetSignalId: extra?.targetSignalId ?? null,
      metadata: extra?.metadata ?? null,
    });
  }

  app.get(
    '/v1/platform/session',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Current platform operator session',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        response: {
          200: PlatformSessionResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_status');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      return { data: { accountId: operator.accountId, role: operator.role } };
    },
  );

  app.get(
    '/v1/platform/status',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Platform health and operational counts',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        response: {
          200: PlatformStatusResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_status');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const checks: {
        config: 'ok' | 'fail';
        database: 'ok' | 'fail' | 'timeout';
        migrations: 'ok' | 'fail' | 'unknown';
      } = {
        config: 'ok',
        database: 'ok',
        migrations: 'ok',
      };
      let ready: 'ready' | 'not_ready' = 'ready';

      if (app.isShuttingDown) {
        checks.database = 'fail';
        checks.migrations = 'unknown';
        ready = 'not_ready';
      } else {
        const databaseStatus = await app.database.checkConnection();
        checks.database = databaseStatus;
        if (databaseStatus !== 'ok') {
          checks.migrations = 'unknown';
          ready = 'not_ready';
        } else {
          const migrationResult = await app.database.checkMigrations();
          checks.migrations = migrationResult.status;
          if (migrationResult.status !== 'ok') {
            ready = 'not_ready';
          }
        }
      }

      const nowIso = now();
      const latestBackupVerification = await getLatestPlatformBackupVerification(app.database.db);
      const latestRestoreDrillAttestation = await getLatestPlatformRestoreDrillAttestation(
        app.database.db,
      );
      const components = await collectOperationalComponents({
        env,
        shuttingDown: app.isShuttingDown,
        databaseConnection: checks.database,
        migrations: checks.migrations,
        latestBackupVerification,
        latestRestoreDrillAttestation,
        nowIso,
      });

      // Opportunistic uptime sample + alert sync; never break status.
      void recordUptimeObservation(app.database.db, {
        sampledAt: nowIso,
        components,
        environment: identity.environment,
        service: identity.service,
        version: identity.version,
        commitSha: identity.commitSha,
      }).catch(() => undefined);

      const counts = await getPlatformStatusCounts(app.database.db);
      await audit(operator.accountId, 'status_viewed', request.id);

      return {
        data: {
          health: {
            live: 'ok' as const,
            ready,
            checks,
            build: {
              service: identity.service,
              environment: identity.environment,
              version: identity.version,
              commitSha: identity.commitSha,
            },
          },
          components,
          counts,
        },
      };
    },
  );

  app.get(
    '/v1/platform/accounts',
    {
      schema: {
        tags: ['Platform'],
        summary: 'List or search accounts',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        querystring: PlatformAccountsQuerySchema,
        response: {
          200: PlatformAccountsResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_accounts');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      let email: string | undefined;
      if (request.query.email) {
        try {
          email = normalizeEmail(request.query.email);
        } catch {
          return { data: { accounts: [] } };
        }
      }

      const accounts = await listPlatformAccounts(app.database.db, {
        limit: request.query.limit ?? 50,
        ...(request.query.status ? { status: request.query.status } : {}),
        ...(email ? { email } : {}),
        ...(request.query.q ? { q: request.query.q } : {}),
      });

      return {
        data: {
          accounts: accounts.map((row) => ({
            accountId: row.accountId,
            status: row.status as
              | 'pending_email'
              | 'pending_password'
              | 'pending_passkey'
              | 'active'
              | 'suspended'
              | 'closed',
            isOwner: row.isOwner,
            email: row.email,
            communitySlug: row.communitySlug,
            membershipStatus: row.membershipStatus,
            suspendedAt: row.suspendedAt === null ? null : toIsoTimestamp(row.suspendedAt),
            createdAt: toIsoTimestamp(row.createdAt),
          })),
        },
      };
    },
  );

  app.get(
    '/v1/platform/accounts/:accountId',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Account detail for operators',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformAccountIdParamsSchema,
        response: {
          200: PlatformAccountDetailResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_accounts');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const detail = await getPlatformAccountDetail(app.database.db, request.params.accountId);
      if (!detail) {
        throw accountNotFoundError();
      }

      await audit(operator.accountId, 'account_inspected', request.id, {
        targetAccountId: detail.accountId,
      });

      return {
        data: {
          accountId: detail.accountId,
          status: detail.status as
            | 'pending_email'
            | 'pending_password'
            | 'pending_passkey'
            | 'active'
            | 'suspended'
            | 'closed',
          isOwner: detail.isOwner,
          email: detail.email,
          communitySlug: detail.communitySlug,
          membershipStatus: detail.membershipStatus,
          suspendedAt: detail.suspendedAt === null ? null : toIsoTimestamp(detail.suspendedAt),
          accountReadyAt:
            detail.accountReadyAt === null ? null : toIsoTimestamp(detail.accountReadyAt),
          closedAt: detail.closedAt === null ? null : toIsoTimestamp(detail.closedAt),
          createdAt: toIsoTimestamp(detail.createdAt),
          updatedAt: toIsoTimestamp(detail.updatedAt),
        },
      };
    },
  );

  app.post(
    '/v1/platform/accounts/:accountId/suspend',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Suspend (restrict) an account',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformAccountIdParamsSchema,
        body: PlatformAccountSuspendBodySchema,
        response: {
          200: PlatformAccountActionResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'manage_accounts');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const targetAccountId = request.params.accountId;
      const nowIso = now();
      const reason = request.body.reason;

      const result = await app.database.db.transaction(async (tx) => {
        const orderedIds =
          operator.accountId === targetAccountId
            ? [operator.accountId]
            : [operator.accountId, targetAccountId].sort((a, b) => a.localeCompare(b));

        const lockedById = new Map<string, AccountRow>();
        for (const id of orderedIds) {
          const row = await lockAccountById(tx, id);
          if (row) {
            lockedById.set(id, row);
          }
        }

        const operatorRow = lockedById.get(operator.accountId);
        if (operatorRow?.status !== 'active') {
          return { kind: 'forbidden' as const };
        }

        const target = lockedById.get(targetAccountId);
        if (!target) {
          return { kind: 'missing' as const };
        }

        if (target.status !== 'active') {
          return { kind: 'ok' as const, account: target, changed: false };
        }

        const suspended = await transitionAccountState(tx, {
          accountId: target.id,
          to: 'suspended',
          at: nowIso,
        });

        await revokeAllAccountSessions(tx, {
          accountId: target.id,
          reason: 'account_suspended',
          now: nowIso,
        });

        await appendIdentitySecurityEvent(tx, {
          id: generateId(),
          accountId: operator.accountId,
          eventType: 'account_suspended',
          occurredAt: nowIso,
          requestId: request.id,
          metadata: {
            targetAccountId: target.id,
            reason,
            actorKind: 'platform_operator',
          },
        });

        await appendPlatformAuditEvent(tx, {
          id: generateId(),
          operatorAccountId: operator.accountId,
          action: 'account_suspended',
          occurredAt: nowIso,
          requestId: request.id,
          targetAccountId: target.id,
          metadata: { reason },
        });

        return { kind: 'ok' as const, account: suspended, changed: true };
      });

      if (result.kind === 'forbidden') {
        reply.callNotFound();
        return;
      }
      if (result.kind === 'missing') {
        throw accountNotFoundError();
      }

      return {
        data: {
          accountId: result.account.id,
          status: result.account.status as
            | 'pending_email'
            | 'pending_password'
            | 'pending_passkey'
            | 'active'
            | 'suspended'
            | 'closed',
          suspendedAt:
            result.account.suspendedAt === null ? null : toIsoTimestamp(result.account.suspendedAt),
          changed: result.changed,
        },
      };
    },
  );

  app.post(
    '/v1/platform/accounts/:accountId/reactivate',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Reactivate a suspended account',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformAccountIdParamsSchema,
        response: {
          200: PlatformAccountActionResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'manage_accounts');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const targetAccountId = request.params.accountId;
      const nowIso = now();

      const result = await app.database.db.transaction(async (tx) => {
        const orderedIds =
          operator.accountId === targetAccountId
            ? [operator.accountId]
            : [operator.accountId, targetAccountId].sort((a, b) => a.localeCompare(b));

        const lockedById = new Map<string, AccountRow>();
        for (const id of orderedIds) {
          const row = await lockAccountById(tx, id);
          if (row) {
            lockedById.set(id, row);
          }
        }

        const operatorRow = lockedById.get(operator.accountId);
        if (operatorRow?.status !== 'active') {
          return { kind: 'forbidden' as const };
        }

        const target = lockedById.get(targetAccountId);
        if (!target) {
          return { kind: 'missing' as const };
        }

        if (target.status !== 'suspended') {
          return { kind: 'ok' as const, account: target, changed: false };
        }

        const activated = await transitionAccountState(tx, {
          accountId: target.id,
          to: 'active',
          at: nowIso,
        });

        await appendIdentitySecurityEvent(tx, {
          id: generateId(),
          accountId: operator.accountId,
          eventType: 'account_activated',
          occurredAt: nowIso,
          requestId: request.id,
          metadata: {
            targetAccountId: target.id,
            actorKind: 'platform_operator',
          },
        });

        await appendPlatformAuditEvent(tx, {
          id: generateId(),
          operatorAccountId: operator.accountId,
          action: 'account_reactivated',
          occurredAt: nowIso,
          requestId: request.id,
          targetAccountId: target.id,
        });

        return { kind: 'ok' as const, account: activated, changed: true };
      });

      if (result.kind === 'forbidden') {
        reply.callNotFound();
        return;
      }
      if (result.kind === 'missing') {
        throw accountNotFoundError();
      }

      return {
        data: {
          accountId: result.account.id,
          status: result.account.status as
            | 'pending_email'
            | 'pending_password'
            | 'pending_passkey'
            | 'active'
            | 'suspended'
            | 'closed',
          suspendedAt:
            result.account.suspendedAt === null ? null : toIsoTimestamp(result.account.suspendedAt),
          changed: result.changed,
        },
      };
    },
  );

  app.get(
    '/v1/platform/communities',
    {
      schema: {
        tags: ['Platform'],
        summary: 'List communities with bound-account counts',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        response: {
          200: PlatformCommunitiesResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_communities');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const rows = await listPlatformCommunities(app.database.db);
      return { data: { communities: rows } };
    },
  );

  app.get(
    '/v1/platform/memberships',
    {
      schema: {
        tags: ['Platform'],
        summary: 'List membership entitlements',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        querystring: PlatformMembershipsQuerySchema,
        response: {
          200: PlatformMembershipsResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_memberships');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const memberships = await listPlatformMemberships(app.database.db, {
        limit: request.query.limit ?? 50,
        ...(request.query.status ? { status: request.query.status } : {}),
        ...(request.query.q ? { q: request.query.q } : {}),
      });
      return {
        data: {
          memberships: memberships.map((row) => ({
            accountId: row.accountId,
            status: row.status,
            source: row.source,
            accessUntil: row.accessUntil === null ? null : toIsoTimestamp(row.accessUntil),
            activatedAt: row.activatedAt === null ? null : toIsoTimestamp(row.activatedAt),
            cancellationRequestedAt:
              row.cancellationRequestedAt === null
                ? null
                : toIsoTimestamp(row.cancellationRequestedAt),
            cancelAtPeriodEnd: row.cancelAtPeriodEnd,
            expiredAt: row.expiredAt === null ? null : toIsoTimestamp(row.expiredAt),
            updatedAt: toIsoTimestamp(row.updatedAt),
            email: row.email,
            allowedActions: computePlatformMembershipAllowedActions({
              source: row.source,
              status: row.status,
            }),
          })),
        },
      };
    },
  );

  app.post(
    '/v1/platform/memberships/grant',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Grant an administrative membership entitlement',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        body: PlatformMembershipGrantBodySchema,
        response: {
          200: PlatformMembershipActionResponseSchema,
          404: DomainErrorResponseSchema,
          409: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'manage_memberships');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const result = await grantPlatformMembership(app.database.db, {
        accountId: request.body.accountId,
        accessUntil: request.body.accessUntil,
        reason: request.body.reason,
        idempotencyKey: request.body.idempotencyKey,
        operatorAccountId: operator.accountId,
        requestId: request.id,
        now: now(),
        generateId,
        cohort: request.body.cohort,
      });

      return {
        data: {
          accountId: result.after.accountId,
          status: result.after.status,
          source: result.after.source,
          accessUntil:
            result.after.accessUntil === null ? null : toIsoTimestamp(result.after.accessUntil),
          activatedAt:
            result.after.activatedAt === null ? null : toIsoTimestamp(result.after.activatedAt),
          cancellationRequestedAt:
            result.after.cancellationRequestedAt === null
              ? null
              : toIsoTimestamp(result.after.cancellationRequestedAt),
          cancelAtPeriodEnd: result.after.cancelAtPeriodEnd,
          expiredAt:
            result.after.expiredAt === null ? null : toIsoTimestamp(result.after.expiredAt),
          changed: result.changed,
          allowedActions: result.allowedActions,
        },
      };
    },
  );

  app.post(
    '/v1/platform/memberships/:accountId/extend',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Extend accessUntil for an administrative membership',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformAccountIdParamsSchema,
        body: PlatformMembershipExtendBodySchema,
        response: {
          200: PlatformMembershipActionResponseSchema,
          404: DomainErrorResponseSchema,
          409: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'manage_memberships');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const result = await extendPlatformMembership(app.database.db, {
        accountId: request.params.accountId,
        accessUntil: request.body.accessUntil,
        reason: request.body.reason,
        idempotencyKey: request.body.idempotencyKey,
        operatorAccountId: operator.accountId,
        requestId: request.id,
        now: now(),
        generateId,
      });

      return {
        data: {
          accountId: result.after.accountId,
          status: result.after.status,
          source: result.after.source,
          accessUntil:
            result.after.accessUntil === null ? null : toIsoTimestamp(result.after.accessUntil),
          activatedAt:
            result.after.activatedAt === null ? null : toIsoTimestamp(result.after.activatedAt),
          cancellationRequestedAt:
            result.after.cancellationRequestedAt === null
              ? null
              : toIsoTimestamp(result.after.cancellationRequestedAt),
          cancelAtPeriodEnd: result.after.cancelAtPeriodEnd,
          expiredAt:
            result.after.expiredAt === null ? null : toIsoTimestamp(result.after.expiredAt),
          changed: result.changed,
          allowedActions: result.allowedActions,
        },
      };
    },
  );

  app.post(
    '/v1/platform/memberships/:accountId/schedule-cancellation',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Schedule cancellation for an administrative membership',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformAccountIdParamsSchema,
        body: PlatformMembershipScheduleCancellationBodySchema,
        response: {
          200: PlatformMembershipActionResponseSchema,
          404: DomainErrorResponseSchema,
          409: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'manage_memberships');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const result = await schedulePlatformMembershipCancellation(app.database.db, {
        accountId: request.params.accountId,
        reason: request.body.reason,
        idempotencyKey: request.body.idempotencyKey,
        operatorAccountId: operator.accountId,
        requestId: request.id,
        now: now(),
        generateId,
      });

      return {
        data: {
          accountId: result.after.accountId,
          status: result.after.status,
          source: result.after.source,
          accessUntil:
            result.after.accessUntil === null ? null : toIsoTimestamp(result.after.accessUntil),
          activatedAt:
            result.after.activatedAt === null ? null : toIsoTimestamp(result.after.activatedAt),
          cancellationRequestedAt:
            result.after.cancellationRequestedAt === null
              ? null
              : toIsoTimestamp(result.after.cancellationRequestedAt),
          cancelAtPeriodEnd: result.after.cancelAtPeriodEnd,
          expiredAt:
            result.after.expiredAt === null ? null : toIsoTimestamp(result.after.expiredAt),
          changed: result.changed,
          allowedActions: result.allowedActions,
        },
      };
    },
  );

  app.get(
    '/v1/platform/signals',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Platform-wide signal moderation inventory',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        querystring: PlatformSignalsQuerySchema,
        response: {
          200: PlatformSignalsResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_signals');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const rows = await listPlatformSignals(app.database.db, {
        limit: request.query.limit ?? 50,
        hiddenOnly: request.query.hiddenOnly ?? false,
      });
      return {
        data: {
          signals: rows.map((row) => ({
            id: row.id,
            slug: row.slug,
            headline: row.headline,
            communitySlug: row.communitySlug,
            authorDisplayName: row.authorDisplayName,
            authorAccountId: row.authorAccountId,
            hidden: row.hidden,
            hiddenAt: row.hiddenAt === null ? null : toIsoTimestamp(row.hiddenAt),
            hiddenReason: row.hiddenReason,
            publishedAt: toIsoTimestamp(row.publishedAt),
          })),
        },
      };
    },
  );

  app.post(
    '/v1/platform/signals/:signalId/hide',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Hide a published signal',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformSignalIdParamsSchema,
        body: PlatformSignalHideBodySchema,
        response: {
          200: PlatformSignalActionResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'moderate_signals');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const nowIso = now();
      const result = await app.database.db.transaction(async (tx) => {
        const hidden = await hideSignal(tx, {
          signalId: request.params.signalId,
          reason: request.body.reason,
          hiddenByAccountId: operator.accountId,
          at: nowIso,
        });
        if (!hidden) {
          return null;
        }
        if (hidden.changed) {
          await appendIdentitySecurityEvent(tx, {
            id: generateId(),
            accountId: operator.accountId,
            eventType: 'signal_hidden',
            occurredAt: nowIso,
            requestId: request.id,
            metadata: {
              signalId: hidden.signal.id,
              reason: request.body.reason,
              actorKind: 'platform_operator',
            },
          });
          await appendPlatformAuditEvent(tx, {
            id: generateId(),
            operatorAccountId: operator.accountId,
            action: 'signal_hidden',
            occurredAt: nowIso,
            requestId: request.id,
            targetSignalId: hidden.signal.id,
            metadata: { reason: request.body.reason },
          });
        }
        return hidden;
      });

      if (!result) {
        reply.callNotFound();
        return;
      }

      return {
        data: {
          signalId: result.signal.id,
          hidden: result.signal.hiddenAt !== null,
          hiddenAt: result.signal.hiddenAt === null ? null : toIsoTimestamp(result.signal.hiddenAt),
          hiddenReason: result.signal.hiddenReason,
          changed: result.changed,
        },
      };
    },
  );

  app.post(
    '/v1/platform/signals/:signalId/unhide',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Unhide a signal',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformSignalIdParamsSchema,
        response: {
          200: PlatformSignalActionResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'moderate_signals');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const nowIso = now();
      const result = await app.database.db.transaction(async (tx) => {
        const visible = await unhideSignal(tx, {
          signalId: request.params.signalId,
          at: nowIso,
        });
        if (!visible) {
          return null;
        }
        if (visible.changed) {
          await appendIdentitySecurityEvent(tx, {
            id: generateId(),
            accountId: operator.accountId,
            eventType: 'signal_unhidden',
            occurredAt: nowIso,
            requestId: request.id,
            metadata: {
              signalId: visible.signal.id,
              actorKind: 'platform_operator',
            },
          });
          await appendPlatformAuditEvent(tx, {
            id: generateId(),
            operatorAccountId: operator.accountId,
            action: 'signal_unhidden',
            occurredAt: nowIso,
            requestId: request.id,
            targetSignalId: visible.signal.id,
          });
        }
        return visible;
      });

      if (!result) {
        reply.callNotFound();
        return;
      }

      return {
        data: {
          signalId: result.signal.id,
          hidden: result.signal.hiddenAt !== null,
          hiddenAt: result.signal.hiddenAt === null ? null : toIsoTimestamp(result.signal.hiddenAt),
          hiddenReason: result.signal.hiddenReason,
          changed: result.changed,
        },
      };
    },
  );

  app.get(
    '/v1/platform/submissions',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Signal submissions moderation inventory',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        querystring: PlatformSubmissionsQuerySchema,
        response: {
          200: PlatformSubmissionsResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_submissions');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const submissions = await listPlatformSubmissions(app.database.db, {
        limit: request.query.limit ?? 50,
        ...(request.query.status ? { status: request.query.status } : {}),
        ...(request.query.communitySlug ? { communitySlug: request.query.communitySlug } : {}),
        ...(request.query.q ? { q: request.query.q } : {}),
      });
      return {
        data: {
          submissions: submissions.map((row) => ({
            id: row.id,
            accountId: row.accountId,
            communitySlug: row.communitySlug,
            headline: row.headline,
            body: row.body,
            status: row.status as 'pending_review' | 'rejected',
            reviewReason: row.reviewReason,
            reviewedAt: row.reviewedAt === null ? null : toIsoTimestamp(row.reviewedAt),
            reviewedByAccountId: row.reviewedByAccountId,
            createdAt: toIsoTimestamp(row.createdAt),
            updatedAt: toIsoTimestamp(row.updatedAt),
            allowedActions: submissionAllowedActions(row.status),
          })),
        },
      };
    },
  );

  app.get(
    '/v1/platform/submissions/:submissionId',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Signal submission detail for moderation',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformSubmissionIdParamsSchema,
        response: {
          200: PlatformSubmissionDetailResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_submissions');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const row = await getPlatformSubmissionDetail(app.database.db, request.params.submissionId);
      if (!row) {
        reply.callNotFound();
        return;
      }
      return {
        data: {
          id: row.id,
          accountId: row.accountId,
          communitySlug: row.communitySlug,
          communityId: row.communityId,
          headline: row.headline,
          body: row.body,
          status: row.status as 'pending_review' | 'rejected',
          reviewReason: row.reviewReason,
          reviewedAt: row.reviewedAt === null ? null : toIsoTimestamp(row.reviewedAt),
          reviewedByAccountId: row.reviewedByAccountId,
          createdAt: toIsoTimestamp(row.createdAt),
          updatedAt: toIsoTimestamp(row.updatedAt),
          allowedActions: submissionAllowedActions(row.status),
        },
      };
    },
  );

  app.post(
    '/v1/platform/submissions/:submissionId/reject',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Reject a pending signal submission',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformSubmissionIdParamsSchema,
        body: PlatformSubmissionRejectBodySchema,
        response: {
          200: PlatformSubmissionActionResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'moderate_signals');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const nowIso = now();
      const result = await app.database.db.transaction(async (tx) => {
        const rejected = await rejectSignalSubmission(tx, {
          submissionId: request.params.submissionId,
          reason: request.body.reason,
          reviewedByAccountId: operator.accountId,
          at: nowIso,
        });
        if (!rejected) {
          return null;
        }
        if (rejected.changed) {
          await appendPlatformAuditEvent(tx, {
            id: generateId(),
            operatorAccountId: operator.accountId,
            action: 'submission_rejected',
            occurredAt: nowIso,
            requestId: request.id,
            targetAccountId: rejected.submission.accountId,
            metadata: {
              contentType: 'signal_submission',
              submissionId: rejected.submission.id,
              communityId: rejected.submission.communityId,
              reason: request.body.reason,
              beforeStatus: 'pending_review',
              afterStatus: 'rejected',
            },
          });
        }
        return rejected;
      });

      if (!result) {
        reply.callNotFound();
        return;
      }

      const detail = await getPlatformSubmissionDetail(app.database.db, result.submission.id);
      return {
        data: {
          id: result.submission.id,
          accountId: result.submission.accountId,
          communitySlug: detail?.communitySlug ?? '',
          status: result.submission.status as 'pending_review' | 'rejected',
          reviewReason: result.submission.reviewReason,
          reviewedAt:
            result.submission.reviewedAt === null
              ? null
              : toIsoTimestamp(result.submission.reviewedAt),
          reviewedByAccountId: result.submission.reviewedByAccountId,
          changed: result.changed,
          allowedActions: submissionAllowedActions(result.submission.status),
        },
      };
    },
  );

  app.post(
    '/v1/platform/submissions/:submissionId/restore',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Restore a rejected signal submission to pending_review',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformSubmissionIdParamsSchema,
        body: PlatformSubmissionRejectBodySchema,
        response: {
          200: PlatformSubmissionActionResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'moderate_signals');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const nowIso = now();
      const result = await app.database.db.transaction(async (tx) => {
        const before = await getPlatformSubmissionDetail(tx, request.params.submissionId);
        const restored = await restoreSignalSubmission(tx, {
          submissionId: request.params.submissionId,
          at: nowIso,
        });
        if (!restored) {
          return null;
        }
        if (restored.changed) {
          await appendPlatformAuditEvent(tx, {
            id: generateId(),
            operatorAccountId: operator.accountId,
            action: 'submission_restored',
            occurredAt: nowIso,
            requestId: request.id,
            targetAccountId: restored.submission.accountId,
            metadata: {
              contentType: 'signal_submission',
              submissionId: restored.submission.id,
              communityId: restored.submission.communityId,
              reason: request.body.reason,
              beforeStatus: before?.status ?? 'rejected',
              afterStatus: 'pending_review',
            },
          });
        }
        return restored;
      });

      if (!result) {
        reply.callNotFound();
        return;
      }

      const detail = await getPlatformSubmissionDetail(app.database.db, result.submission.id);
      return {
        data: {
          id: result.submission.id,
          accountId: result.submission.accountId,
          communitySlug: detail?.communitySlug ?? '',
          status: result.submission.status as 'pending_review' | 'rejected',
          reviewReason: result.submission.reviewReason,
          reviewedAt:
            result.submission.reviewedAt === null
              ? null
              : toIsoTimestamp(result.submission.reviewedAt),
          reviewedByAccountId: result.submission.reviewedByAccountId,
          changed: result.changed,
          allowedActions: submissionAllowedActions(result.submission.status),
        },
      };
    },
  );

  app.get(
    '/v1/platform/discussions',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Discussion contributions moderation inventory',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        querystring: PlatformDiscussionsQuerySchema,
        response: {
          200: PlatformDiscussionsResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_discussions');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const contributions = await listPlatformDiscussions(app.database.db, {
        limit: request.query.limit ?? 50,
        hiddenOnly: request.query.hiddenOnly ?? false,
        ...(request.query.communitySlug ? { communitySlug: request.query.communitySlug } : {}),
        ...(request.query.q ? { q: request.query.q } : {}),
      });
      return {
        data: {
          contributions: contributions.flatMap((row) => {
            if (!row.accountId) {
              return [];
            }
            return [
              {
                contributionId: row.contributionId,
                sessionId: row.sessionId,
                signalId: row.signalId,
                signalSlug: row.signalSlug,
                communitySlug: row.communitySlug,
                intent: row.intent,
                body: row.body,
                accountId: row.accountId,
                hidden: row.hidden,
                hiddenAt: row.hiddenAt === null ? null : toIsoTimestamp(row.hiddenAt),
                hiddenReason: row.hiddenReason,
                createdAt: toIsoTimestamp(row.createdAt),
                allowedActions: discussionAllowedActions(row.hidden),
              },
            ];
          }),
        },
      };
    },
  );

  app.post(
    '/v1/platform/discussions/:contributionId/hide',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Hide a discussion contribution',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformDiscussionContributionIdParamsSchema,
        body: PlatformDiscussionHideBodySchema,
        response: {
          200: PlatformDiscussionActionResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'moderate_signals');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const nowIso = now();
      const result = await app.database.db.transaction(async (tx) => {
        const hidden = await hideDiscussionContribution(tx, {
          contributionId: request.params.contributionId,
          reason: request.body.reason,
          hiddenByAccountId: operator.accountId,
          at: nowIso,
        });
        if (!hidden) {
          return null;
        }

        const actorRows = await tx
          .select({ accountId: actors.accountId })
          .from(actors)
          .where(eq(actors.id, hidden.contribution.actorId))
          .limit(1);
        const authorAccountId = actorRows[0]?.accountId ?? null;

        if (hidden.changed) {
          await appendPlatformAuditEvent(tx, {
            id: generateId(),
            operatorAccountId: operator.accountId,
            action: 'discussion_contribution_hidden',
            occurredAt: nowIso,
            requestId: request.id,
            targetAccountId: authorAccountId,
            targetSignalId: hidden.contribution.signalId,
            metadata: {
              contentType: 'discussion_contribution',
              contributionId: hidden.contribution.id,
              sessionId: hidden.contribution.sessionId,
              signalId: hidden.contribution.signalId,
              reason: request.body.reason,
              beforeHidden: false,
              afterHidden: true,
            },
          });
        }
        return { hidden, authorAccountId };
      });

      if (!result) {
        reply.callNotFound();
        return;
      }

      const isHidden = result.hidden.contribution.hiddenAt !== null;
      return {
        data: {
          contributionId: result.hidden.contribution.id,
          signalId: result.hidden.contribution.signalId,
          accountId: result.authorAccountId,
          hidden: isHidden,
          hiddenAt:
            result.hidden.contribution.hiddenAt === null
              ? null
              : toIsoTimestamp(result.hidden.contribution.hiddenAt),
          hiddenReason: result.hidden.contribution.hiddenReason,
          changed: result.hidden.changed,
          allowedActions: discussionAllowedActions(isHidden),
        },
      };
    },
  );

  app.post(
    '/v1/platform/discussions/:contributionId/unhide',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Unhide a discussion contribution',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformDiscussionContributionIdParamsSchema,
        body: PlatformDiscussionHideBodySchema,
        response: {
          200: PlatformDiscussionActionResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'moderate_signals');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const nowIso = now();
      const result = await app.database.db.transaction(async (tx) => {
        const visible = await unhideDiscussionContribution(tx, {
          contributionId: request.params.contributionId,
        });
        if (!visible) {
          return null;
        }

        const actorRows = await tx
          .select({ accountId: actors.accountId })
          .from(actors)
          .where(eq(actors.id, visible.contribution.actorId))
          .limit(1);
        const authorAccountId = actorRows[0]?.accountId ?? null;

        if (visible.changed) {
          await appendPlatformAuditEvent(tx, {
            id: generateId(),
            operatorAccountId: operator.accountId,
            action: 'discussion_contribution_unhidden',
            occurredAt: nowIso,
            requestId: request.id,
            targetAccountId: authorAccountId,
            targetSignalId: visible.contribution.signalId,
            metadata: {
              contentType: 'discussion_contribution',
              contributionId: visible.contribution.id,
              sessionId: visible.contribution.sessionId,
              signalId: visible.contribution.signalId,
              reason: request.body.reason,
              beforeHidden: true,
              afterHidden: false,
            },
          });
        }
        return { visible, authorAccountId };
      });

      if (!result) {
        reply.callNotFound();
        return;
      }

      const isHidden = result.visible.contribution.hiddenAt !== null;
      return {
        data: {
          contributionId: result.visible.contribution.id,
          signalId: result.visible.contribution.signalId,
          accountId: result.authorAccountId,
          hidden: isHidden,
          hiddenAt:
            result.visible.contribution.hiddenAt === null
              ? null
              : toIsoTimestamp(result.visible.contribution.hiddenAt),
          hiddenReason: result.visible.contribution.hiddenReason,
          changed: result.visible.changed,
          allowedActions: discussionAllowedActions(isHidden),
        },
      };
    },
  );

  app.get(
    '/v1/platform/errors',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Recent sanitized technical errors for operator diagnosis',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        querystring: PlatformTechnicalErrorsQuerySchema,
        response: {
          200: PlatformTechnicalErrorsResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_status');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const errors = await listPlatformTechnicalErrors(app.database.db, {
        limit: request.query.limit ?? 20,
      });
      await audit(operator.accountId, 'technical_errors_inspected', request.id);

      return {
        data: {
          errors: errors.map((row) => ({
            id: row.id,
            occurredAt: toIsoTimestamp(row.occurredAt),
            requestId: row.requestId,
            method: row.method,
            route: row.route,
            statusCode: row.statusCode,
            errorCode: row.errorCode,
            errorName: row.errorName,
            message: row.message,
            environment: row.environment,
            service: row.service,
            version: row.version,
            commitSha: row.commitSha,
          })),
        },
      };
    },
  );

  app.get(
    '/v1/platform/uptime',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Recent uptime samples and ok-ratio summary for operator monitoring',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        querystring: PlatformUptimeQuerySchema,
        response: {
          200: PlatformUptimeResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_status');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const summarized = await summarizePlatformUptimeSamples(app.database.db, {
        limit: request.query.limit ?? 48,
      });
      const openAlertCount = await countOpenPlatformAlerts(app.database.db);
      await audit(operator.accountId, 'uptime_inspected', request.id);

      return {
        data: {
          summary: {
            sampleCount: summarized.sampleCount,
            okCount: summarized.okCount,
            okRatio: summarized.okRatio,
            openAlertCount,
            windowStartedAt:
              summarized.windowStartedAt === null
                ? null
                : toIsoTimestamp(summarized.windowStartedAt),
            windowEndedAt:
              summarized.windowEndedAt === null ? null : toIsoTimestamp(summarized.windowEndedAt),
          },
          samples: summarized.samples.map((row) => ({
            id: row.id,
            sampledAt: toIsoTimestamp(row.sampledAt),
            overallStatus: row.overallStatus as
              'ok' | 'degraded' | 'fail' | 'timeout' | 'misconfigured',
            components: {
              api: row.apiStatus as
                'ok' | 'degraded' | 'fail' | 'timeout' | 'disabled' | 'misconfigured',
              database: row.databaseStatus as
                'ok' | 'degraded' | 'fail' | 'timeout' | 'disabled' | 'misconfigured',
              email: row.emailStatus as
                'ok' | 'degraded' | 'fail' | 'timeout' | 'disabled' | 'misconfigured',
              stripe: row.stripeStatus as
                'ok' | 'degraded' | 'fail' | 'timeout' | 'disabled' | 'misconfigured',
            },
            environment: row.environment,
            service: row.service,
            version: row.version,
            commitSha: row.commitSha,
          })),
        },
      };
    },
  );

  app.get(
    '/v1/platform/alerts',
    {
      schema: {
        tags: ['Platform'],
        summary: 'In-console operational alerts for unhealthy components',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        querystring: PlatformAlertsQuerySchema,
        response: {
          200: PlatformAlertsResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_status');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const alerts = await listPlatformAlerts(app.database.db, {
        limit: request.query.limit ?? 20,
        state: request.query.state ?? 'open',
      });
      await audit(operator.accountId, 'alerts_inspected', request.id);

      return {
        data: {
          alerts: alerts.map((row) => ({
            id: row.id,
            openedAt: toIsoTimestamp(row.openedAt),
            component: row.component as
              'api' | 'database' | 'email' | 'stripe' | 'backup' | 'restore',
            status: row.status as 'degraded' | 'fail' | 'timeout' | 'misconfigured',
            severity: row.severity as 'warning' | 'critical',
            detail: row.detail,
            environment: row.environment,
            commitSha: row.commitSha,
            resolvedAt: row.resolvedAt === null ? null : toIsoTimestamp(row.resolvedAt),
            acknowledgedAt: row.acknowledgedAt === null ? null : toIsoTimestamp(row.acknowledgedAt),
            acknowledgedByAccountId: row.acknowledgedByAccountId,
          })),
        },
      };
    },
  );

  app.get(
    '/v1/platform/backup',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Automated Postgres PITR backup config and operator verifications',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        response: {
          200: PlatformBackupResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_status');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const config = readPlatformBackupConfig(env);
      const recent = await listPlatformBackupVerifications(app.database.db, { limit: 10 });
      const latest = recent[0] ?? null;
      const status = assessBackupComponent({
        env,
        latestVerification: latest,
        nowIso: now(),
      });
      await audit(operator.accountId, 'backup_inspected', request.id);

      const toItem = (row: (typeof recent)[number]) => ({
        id: row.id,
        verifiedAt: toIsoTimestamp(row.verifiedAt),
        verifiedByAccountId: row.verifiedByAccountId,
        provider: row.provider as 'none' | 'railway_postgres_pitr',
        pitrEnabled: row.pitrEnabled,
        retentionDays: row.retentionDays,
        note: row.note,
        environment: row.environment,
        commitSha: row.commitSha,
      });

      return {
        data: {
          config: {
            provider: config.provider,
            pitrEnabled: config.pitrEnabled,
            retentionDays: config.retentionDays,
            verifyMaxAgeDays: config.verifyMaxAgeDays,
            automated: config.automated,
          },
          status,
          latestVerification: latest === null ? null : toItem(latest),
          recentVerifications: recent.map(toItem),
        },
      };
    },
  );

  app.post(
    '/v1/platform/backup/verify',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Record operator verification that platform PITR backup is active',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        body: PlatformBackupVerifyBodySchema,
        response: {
          200: PlatformBackupVerifyResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'manage_backup');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const config = readPlatformBackupConfig(env);
      if (!config.automated || config.retentionDays === null) {
        reply.callNotFound();
        return;
      }

      const verifiedAt = now();
      const verification = await appendPlatformBackupVerification(app.database.db, {
        verifiedAt,
        verifiedByAccountId: operator.accountId,
        provider: config.provider,
        pitrEnabled: config.pitrEnabled,
        retentionDays: config.retentionDays,
        note: sanitizeBackupNote(request.body.note),
        environment: identity.environment,
        commitSha: identity.commitSha,
      });

      await audit(operator.accountId, 'backup_verified', request.id, {
        metadata: {
          provider: config.provider,
          retentionDays: config.retentionDays,
          verificationId: verification.id,
        },
      });

      const status = assessBackupComponent({
        env,
        latestVerification: verification,
        nowIso: verifiedAt,
      });

      return {
        data: {
          verification: {
            id: verification.id,
            verifiedAt: toIsoTimestamp(verification.verifiedAt),
            verifiedByAccountId: verification.verifiedByAccountId,
            provider: verification.provider as 'none' | 'railway_postgres_pitr',
            pitrEnabled: verification.pitrEnabled,
            retentionDays: verification.retentionDays,
            note: verification.note,
            environment: verification.environment,
            commitSha: verification.commitSha,
          },
          status,
        },
      };
    },
  );

  app.get(
    '/v1/platform/restore',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Restore-drill attestation status (never executes database restore)',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        response: {
          200: PlatformRestoreResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_status');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const config = readPlatformRestoreDrillConfig(env);
      const recent = await listPlatformRestoreDrillAttestations(app.database.db, { limit: 10 });
      const latest = recent[0] ?? null;
      const status = assessRestoreComponent({
        env,
        latestAttestation: latest,
        nowIso: now(),
      });
      await audit(operator.accountId, 'restore_inspected', request.id);

      const toItem = (row: (typeof recent)[number]) => ({
        id: row.id,
        drilledAt: toIsoTimestamp(row.drilledAt),
        drilledByAccountId: row.drilledByAccountId,
        method: row.method as 'railway_pitr_disposable_clone' | 'railway_pitr_point_in_time',
        outcome: row.outcome as 'passed' | 'failed',
        restorePointAt: row.restorePointAt === null ? null : toIsoTimestamp(row.restorePointAt),
        note: row.note,
        environment: row.environment,
        commitSha: row.commitSha,
      });

      return {
        data: {
          config: {
            maxAgeDays: config.maxAgeDays,
            requiresAutomatedBackup: config.requiresAutomatedBackup,
          },
          status,
          latestAttestation: latest === null ? null : toItem(latest),
          recentAttestations: recent.map(toItem),
        },
      };
    },
  );

  app.post(
    '/v1/platform/restore/attest',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Record that an out-of-band restore drill was performed (ops_admin+)',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        body: PlatformRestoreAttestBodySchema,
        response: {
          200: PlatformRestoreAttestResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'manage_restore');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const backup = readPlatformBackupConfig(env);
      if (!backup.automated) {
        reply.callNotFound();
        return;
      }

      const drilledAt = now();
      const restorePointAt =
        typeof request.body.restorePointAt === 'string' ? request.body.restorePointAt : null;
      if (restorePointAt !== null) {
        const restorePointMs = Date.parse(restorePointAt);
        const drilledMs = Date.parse(drilledAt);
        if (
          !Number.isFinite(restorePointMs) ||
          !Number.isFinite(drilledMs) ||
          restorePointMs > drilledMs
        ) {
          reply.callNotFound();
          return;
        }
      }

      const attestation = await appendPlatformRestoreDrillAttestation(app.database.db, {
        drilledAt,
        drilledByAccountId: operator.accountId,
        method: request.body.method,
        outcome: request.body.outcome,
        restorePointAt,
        note: sanitizeRestoreDrillNote(request.body.note),
        environment: identity.environment,
        commitSha: identity.commitSha,
      });

      await audit(operator.accountId, 'restore_drill_attested', request.id, {
        metadata: {
          method: request.body.method,
          outcome: request.body.outcome,
          attestationId: attestation.id,
        },
      });

      const status = assessRestoreComponent({
        env,
        latestAttestation: attestation,
        nowIso: drilledAt,
      });

      return {
        data: {
          attestation: {
            id: attestation.id,
            drilledAt: toIsoTimestamp(attestation.drilledAt),
            drilledByAccountId: attestation.drilledByAccountId,
            method: attestation.method as
              'railway_pitr_disposable_clone' | 'railway_pitr_point_in_time',
            outcome: attestation.outcome as 'passed' | 'failed',
            restorePointAt:
              attestation.restorePointAt === null
                ? null
                : toIsoTimestamp(attestation.restorePointAt),
            note: attestation.note,
            environment: attestation.environment,
            commitSha: attestation.commitSha,
          },
          status,
        },
      };
    },
  );

  app.post(
    '/v1/platform/alerts/:alertId/acknowledge',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Acknowledge an operational alert (ops_admin+)',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformAlertIdParamsSchema,
        response: {
          200: PlatformAlertActionResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'manage_alerts');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const result = await acknowledgePlatformAlert(app.database.db, {
        alertId: request.params.alertId,
        acknowledgedAt: now(),
        acknowledgedByAccountId: operator.accountId,
      });
      if (!result) {
        reply.callNotFound();
        return;
      }

      if (result.changed) {
        await audit(operator.accountId, 'alert_acknowledged', request.id, {
          metadata: {
            alertId: result.row.id,
            component: result.row.component,
            status: result.row.status,
          },
        });
      }

      const row = result.row;
      return {
        data: {
          alert: {
            id: row.id,
            openedAt: toIsoTimestamp(row.openedAt),
            component: row.component as
              'api' | 'database' | 'email' | 'stripe' | 'backup' | 'restore',
            status: row.status as 'degraded' | 'fail' | 'timeout' | 'misconfigured',
            severity: row.severity as 'warning' | 'critical',
            detail: row.detail,
            environment: row.environment,
            commitSha: row.commitSha,
            resolvedAt: row.resolvedAt === null ? null : toIsoTimestamp(row.resolvedAt),
            acknowledgedAt: row.acknowledgedAt === null ? null : toIsoTimestamp(row.acknowledgedAt),
            acknowledgedByAccountId: row.acknowledgedByAccountId,
          },
          changed: result.changed,
        },
      };
    },
  );

  app.get(
    '/v1/platform/audit',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Platform operator audit history',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        querystring: PlatformAuditQuerySchema,
        response: {
          200: PlatformAuditResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_audit');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const action =
        request.query.action && isPlatformAuditAction(request.query.action)
          ? request.query.action
          : undefined;

      const events = await listPlatformAuditEvents(app.database.db, {
        limit: request.query.limit ?? 50,
        ...(request.query.operatorAccountId
          ? { operatorAccountId: request.query.operatorAccountId }
          : {}),
        ...(request.query.targetAccountId
          ? { targetAccountId: request.query.targetAccountId }
          : {}),
        ...(action ? { action } : {}),
        ...(request.query.from ? { from: request.query.from } : {}),
        ...(request.query.to ? { to: request.query.to } : {}),
      });

      await audit(operator.accountId, 'audit_inspected', request.id);

      return {
        data: {
          events: events.map((event) => ({
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
    },
  );

  app.get(
    '/v1/platform/accounts/:accountId/export',
    {
      schema: {
        tags: ['Platform'],
        summary:
          'Download a bounded investigation/support pack for one account (no Stripe IDs or secrets)',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformAccountIdParamsSchema,
        response: {
          200: PlatformInvestigationExportResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'export_investigation');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const pack = await buildPlatformInvestigationExport(app.database.db, {
        accountId: request.params.accountId,
        generatedAt: now(),
      });
      if (!pack) {
        throw accountNotFoundError();
      }

      await audit(operator.accountId, 'investigation_exported', request.id, {
        targetAccountId: pack.accountId,
        metadata: {
          sections: 'account,emails,payments,platformAudit',
        },
      });

      return { data: pack };
    },
  );

  app.get(
    '/v1/platform/accounts/:accountId/emails',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Investigate account emails and challenges',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformAccountIdParamsSchema,
        response: {
          200: PlatformAccountEmailsResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_emails');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const account = await findAccountById(app.database.db, request.params.accountId);
      if (!account) {
        throw accountNotFoundError();
      }

      const data = await getPlatformAccountEmails(app.database.db, request.params.accountId);
      await audit(operator.accountId, 'email_inspected', request.id, {
        targetAccountId: request.params.accountId,
      });

      return {
        data: {
          emails: data.emails.map((row) => ({
            ...row,
            verifiedAt: row.verifiedAt === null ? null : toIsoTimestamp(row.verifiedAt),
            revokedAt: row.revokedAt === null ? null : toIsoTimestamp(row.revokedAt),
            createdAt: toIsoTimestamp(row.createdAt),
          })),
          challenges: data.challenges.map((row) => ({
            ...row,
            createdAt: toIsoTimestamp(row.createdAt),
            expiresAt: toIsoTimestamp(row.expiresAt),
            consumedAt: row.consumedAt === null ? null : toIsoTimestamp(row.consumedAt),
            revokedAt: row.revokedAt === null ? null : toIsoTimestamp(row.revokedAt),
          })),
        },
      };
    },
  );

  app.get(
    '/v1/platform/accounts/:accountId/payments',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Investigate membership and Stripe ledger without exposing Stripe IDs',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformAccountIdParamsSchema,
        response: {
          200: PlatformAccountPaymentsResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'read_payments');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      const account = await findAccountById(app.database.db, request.params.accountId);
      if (!account) {
        throw accountNotFoundError();
      }

      const data = await getPlatformAccountPayments(app.database.db, request.params.accountId);
      await audit(operator.accountId, 'payment_inspected', request.id, {
        targetAccountId: request.params.accountId,
      });

      return {
        data: {
          entitlement: data.entitlement
            ? {
                status: data.entitlement.status,
                source: data.entitlement.source,
                accessUntil:
                  data.entitlement.accessUntil === null
                    ? null
                    : toIsoTimestamp(data.entitlement.accessUntil),
                cancelAtPeriodEnd: data.entitlement.cancelAtPeriodEnd,
                activatedAt:
                  data.entitlement.activatedAt === null
                    ? null
                    : toIsoTimestamp(data.entitlement.activatedAt),
                cancellationRequestedAt:
                  data.entitlement.cancellationRequestedAt === null
                    ? null
                    : toIsoTimestamp(data.entitlement.cancellationRequestedAt),
                expiredAt:
                  data.entitlement.expiredAt === null
                    ? null
                    : toIsoTimestamp(data.entitlement.expiredAt),
                version: data.entitlement.version,
                updatedAt: toIsoTimestamp(data.entitlement.updatedAt),
              }
            : null,
          stripeCustomer: data.stripeCustomer.linked
            ? {
                linked: true as const,
                billingReference: data.stripeCustomer.billingReference,
                createdAt: toIsoTimestamp(data.stripeCustomer.createdAt),
                updatedAt: toIsoTimestamp(data.stripeCustomer.updatedAt),
              }
            : { linked: false as const },
          checkoutAttempts: data.checkoutAttempts.map((row) => ({
            id: row.id,
            status: row.status,
            hasStripeSession: row.hasStripeSession,
            createdAt: toIsoTimestamp(row.createdAt),
            expiresAt: toIsoTimestamp(row.expiresAt),
            completedAt: row.completedAt === null ? null : toIsoTimestamp(row.completedAt),
          })),
        },
      };
    },
  );

  app.get(
    '/v1/platform/operators',
    {
      schema: {
        tags: ['Platform'],
        summary: 'List active platform operators',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        response: {
          200: PlatformOperatorsResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'manage_operators');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const operators = await listActivePlatformOperators(app.database.db);
      return {
        data: {
          operators: operators.map((row) => ({
            accountId: row.accountId,
            role: row.role as
              | 'viewer'
              | 'investigator'
              | 'moderator'
              | 'account_admin'
              | 'ops_admin'
              | 'role_admin',
            grantedAt: toIsoTimestamp(row.grantedAt),
            grantedByAccountId: row.grantedByAccountId,
          })),
        },
      };
    },
  );

  app.post(
    '/v1/platform/operators',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Grant or update a platform operator role',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        body: PlatformOperatorGrantBodySchema,
        response: {
          200: PlatformOperatorActionResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'manage_operators');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      if (!isPlatformOperatorRole(request.body.role)) {
        reply.callNotFound();
        return;
      }

      const target = await findAccountById(app.database.db, request.body.accountId);
      if (!target) {
        throw accountNotFoundError();
      }

      const nowIso = now();
      const result = await upsertPlatformOperator(app.database.db, {
        accountId: request.body.accountId,
        role: request.body.role,
        grantedByAccountId: operator.accountId,
        at: nowIso,
      });

      if (result.outcome !== 'already_active') {
        await appendPlatformAuditEvent(app.database.db, {
          id: generateId(),
          operatorAccountId: operator.accountId,
          action: result.outcome === 'role_changed' ? 'operator_role_changed' : 'operator_granted',
          occurredAt: nowIso,
          requestId: request.id,
          targetAccountId: request.body.accountId,
          metadata: { role: request.body.role },
        });
      }

      return {
        data: {
          accountId: result.row.accountId,
          role: result.row.role as
            'viewer' | 'investigator' | 'moderator' | 'account_admin' | 'ops_admin' | 'role_admin',
          active: result.row.revokedAt === null,
          changed: result.outcome !== 'already_active',
        },
      };
    },
  );

  app.post(
    '/v1/platform/operators/:accountId/revoke',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Revoke platform operator access',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformAccountIdParamsSchema,
        response: {
          200: PlatformOperatorActionResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'manage_operators');
      if (!operator) {
        reply.callNotFound();
        return;
      }

      if (request.params.accountId === operator.accountId) {
        reply.callNotFound();
        return;
      }

      const nowIso = now();
      const result = await revokePlatformOperator(app.database.db, {
        accountId: request.params.accountId,
        at: nowIso,
      });
      if (!result) {
        throw accountNotFoundError();
      }

      if (result.changed) {
        await appendPlatformAuditEvent(app.database.db, {
          id: generateId(),
          operatorAccountId: operator.accountId,
          action: 'operator_revoked',
          occurredAt: nowIso,
          requestId: request.id,
          targetAccountId: request.params.accountId,
          metadata: { role: result.row.role },
        });
      }

      return {
        data: {
          accountId: result.row.accountId,
          role: result.row.role as
            'viewer' | 'investigator' | 'moderator' | 'account_admin' | 'ops_admin' | 'role_admin',
          active: result.row.revokedAt === null,
          changed: result.changed,
        },
      };
    },
  );

  // §14: moderate_civic_process — hide/restore a proposal, deliberation
  // contribution, or verification evidence item; record a procedural
  // contestation outcome (§10); record a stalled verification-dispute
  // outcome (§13). None of these touch current_stage, civic_process_transitions,
  // or civic_process_events, and none alter a published mandate.

  app.post(
    '/v1/platform/civic/proposals/:contentId/hide',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Hide a civic proposal',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformCivicContentIdParamsSchema,
        body: PlatformCivicContentHideBodySchema,
        response: PlatformCivicModerationRouteResponses.hideContent,
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'moderate_civic_process');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const result = await hideCivicProposal(app.database.db, {
        proposalId: request.params.contentId,
        reason: request.body.reason,
        hiddenByAccountId: operator.accountId,
        at: now(),
      });
      if (!result) {
        reply.callNotFound();
        return;
      }
      if (result.changed) {
        await audit(operator.accountId, 'civic_content_hidden', request.id, {
          metadata: {
            contentType: 'proposal',
            contentId: result.proposal.id,
            reason: request.body.reason,
          },
        });
      }
      return {
        data: {
          contentId: result.proposal.id,
          hidden: result.proposal.hiddenAt !== null,
          hiddenAt:
            result.proposal.hiddenAt === null ? null : toIsoTimestamp(result.proposal.hiddenAt),
          hiddenReason: result.proposal.hiddenReason,
          changed: result.changed,
        },
      };
    },
  );

  app.post(
    '/v1/platform/civic/proposals/:contentId/unhide',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Unhide a civic proposal',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformCivicContentIdParamsSchema,
        response: PlatformCivicModerationRouteResponses.hideContent,
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'moderate_civic_process');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const result = await unhideCivicProposal(app.database.db, {
        proposalId: request.params.contentId,
      });
      if (!result) {
        reply.callNotFound();
        return;
      }
      if (result.changed) {
        await audit(operator.accountId, 'civic_content_unhidden', request.id, {
          metadata: { contentType: 'proposal', contentId: result.proposal.id },
        });
      }
      return {
        data: {
          contentId: result.proposal.id,
          hidden: result.proposal.hiddenAt !== null,
          hiddenAt:
            result.proposal.hiddenAt === null ? null : toIsoTimestamp(result.proposal.hiddenAt),
          hiddenReason: result.proposal.hiddenReason,
          changed: result.changed,
        },
      };
    },
  );

  app.post(
    '/v1/platform/civic/deliberation-contributions/:contentId/hide',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Hide a civic deliberation contribution',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformCivicContentIdParamsSchema,
        body: PlatformCivicContentHideBodySchema,
        response: PlatformCivicModerationRouteResponses.hideContent,
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'moderate_civic_process');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const result = await hideCivicDeliberationContribution(app.database.db, {
        contributionId: request.params.contentId,
        reason: request.body.reason,
        hiddenByAccountId: operator.accountId,
        at: now(),
      });
      if (!result) {
        reply.callNotFound();
        return;
      }
      if (result.changed) {
        await audit(operator.accountId, 'civic_content_hidden', request.id, {
          metadata: {
            contentType: 'deliberation_contribution',
            contentId: result.contribution.id,
            reason: request.body.reason,
          },
        });
      }
      return {
        data: {
          contentId: result.contribution.id,
          hidden: result.contribution.hiddenAt !== null,
          hiddenAt:
            result.contribution.hiddenAt === null
              ? null
              : toIsoTimestamp(result.contribution.hiddenAt),
          hiddenReason: result.contribution.hiddenReason,
          changed: result.changed,
        },
      };
    },
  );

  app.post(
    '/v1/platform/civic/deliberation-contributions/:contentId/unhide',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Unhide a civic deliberation contribution',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformCivicContentIdParamsSchema,
        response: PlatformCivicModerationRouteResponses.hideContent,
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'moderate_civic_process');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const result = await unhideCivicDeliberationContribution(app.database.db, {
        contributionId: request.params.contentId,
      });
      if (!result) {
        reply.callNotFound();
        return;
      }
      if (result.changed) {
        await audit(operator.accountId, 'civic_content_unhidden', request.id, {
          metadata: { contentType: 'deliberation_contribution', contentId: result.contribution.id },
        });
      }
      return {
        data: {
          contentId: result.contribution.id,
          hidden: result.contribution.hiddenAt !== null,
          hiddenAt:
            result.contribution.hiddenAt === null
              ? null
              : toIsoTimestamp(result.contribution.hiddenAt),
          hiddenReason: result.contribution.hiddenReason,
          changed: result.changed,
        },
      };
    },
  );

  app.post(
    '/v1/platform/civic/verification-evidence/:contentId/hide',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Hide a civic verification evidence item',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformCivicContentIdParamsSchema,
        body: PlatformCivicContentHideBodySchema,
        response: PlatformCivicModerationRouteResponses.hideContent,
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'moderate_civic_process');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const result = await hideCivicVerificationEvidence(app.database.db, {
        evidenceId: request.params.contentId,
        reason: request.body.reason,
        hiddenByAccountId: operator.accountId,
        at: now(),
      });
      if (!result) {
        reply.callNotFound();
        return;
      }
      if (result.changed) {
        await audit(operator.accountId, 'civic_content_hidden', request.id, {
          metadata: {
            contentType: 'verification_evidence',
            contentId: result.evidence.id,
            reason: request.body.reason,
          },
        });
      }
      return {
        data: {
          contentId: result.evidence.id,
          hidden: result.evidence.hiddenAt !== null,
          hiddenAt:
            result.evidence.hiddenAt === null ? null : toIsoTimestamp(result.evidence.hiddenAt),
          hiddenReason: result.evidence.hiddenReason,
          changed: result.changed,
        },
      };
    },
  );

  app.post(
    '/v1/platform/civic/verification-evidence/:contentId/unhide',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Unhide a civic verification evidence item',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformCivicContentIdParamsSchema,
        response: PlatformCivicModerationRouteResponses.hideContent,
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'moderate_civic_process');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const result = await unhideCivicVerificationEvidence(app.database.db, {
        evidenceId: request.params.contentId,
      });
      if (!result) {
        reply.callNotFound();
        return;
      }
      if (result.changed) {
        await audit(operator.accountId, 'civic_content_unhidden', request.id, {
          metadata: { contentType: 'verification_evidence', contentId: result.evidence.id },
        });
      }
      return {
        data: {
          contentId: result.evidence.id,
          hidden: result.evidence.hiddenAt !== null,
          hiddenAt:
            result.evidence.hiddenAt === null ? null : toIsoTimestamp(result.evidence.hiddenAt),
          hiddenReason: result.evidence.hiddenReason,
          changed: result.changed,
        },
      };
    },
  );

  app.get(
    '/v1/platform/civic/contestations',
    {
      schema: {
        tags: ['Platform'],
        summary: 'List mandate contestations still awaiting review (§10)',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        response: PlatformCivicModerationRouteResponses.contestationsQueue,
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'moderate_civic_process');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const contestations = await listPendingCivicMandateContestations(app.database.db);
      return {
        data: {
          contestations: contestations.map((contestation) => ({
            id: contestation.id,
            processId: contestation.processId,
            reasonKey: contestation.reasonKey,
            elaboration: contestation.elaboration,
            status: contestation.status,
            filedAt: toIsoTimestamp(contestation.filedAt),
          })),
        },
      };
    },
  );

  app.post(
    '/v1/platform/civic/contestations/:contestationId/resolve',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Record a procedural contestation outcome (§10)',
        description:
          'Upheld or rejected, once, permanently. Never touches current_stage, civic_process_transitions, or civic_process_events, and never alters a published mandate.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformCivicContestationIdParamsSchema,
        body: PlatformCivicContestationResolveBodySchema,
        response: PlatformCivicModerationRouteResponses.resolveContestation,
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'moderate_civic_process');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const contestation = await findCivicMandateContestationById(
        app.database.db,
        request.params.contestationId,
      );
      if (!contestation) {
        reply.callNotFound();
        return;
      }
      const nowIso = now();
      const changed =
        contestation.status === 'pending'
          ? await resolveCivicMandateContestation(app.database.db, {
              id: contestation.id,
              status: request.body.status,
              reviewedByAccountId: operator.accountId,
              reviewedAt: nowIso,
              reviewNote: request.body.reviewNote ?? null,
            })
          : false;
      if (changed) {
        await audit(operator.accountId, 'civic_contestation_resolved', request.id, {
          metadata: {
            contestationId: contestation.id,
            processId: contestation.processId,
            status: request.body.status,
          },
        });
      }
      return {
        data: {
          contestationId: contestation.id,
          status: changed ? request.body.status : contestation.status,
          reviewedAt: changed ? toIsoTimestamp(nowIso) : null,
          changed,
        },
      };
    },
  );

  app.get(
    '/v1/platform/civic/verification-disputes',
    {
      schema: {
        tags: ['Platform'],
        summary: 'List verification disputes escalated past 14 days and still unresolved (§13)',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        response: PlatformCivicModerationRouteResponses.verificationDisputesQueue,
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'moderate_civic_process');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const disputes = await listEscalatedUnresolvedCivicVerificationDisputes(app.database.db, {
        now: now(),
      });
      return {
        data: {
          disputes: disputes.map((dispute) => ({
            processId: dispute.processId,
            verificationOpenedAt: toIsoTimestamp(dispute.verificationOpenedAt),
          })),
        },
      };
    },
  );

  app.post(
    '/v1/platform/civic/verification-disputes/:processId/resolve',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Record a stalled verification-dispute outcome (§13)',
        description:
          'Delivered or not_delivered, once, permanently. Never touches current_stage, civic_process_transitions, or civic_process_events — the process stays "verification" forever; this is a public, permanent annotation only.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: PlatformCivicVerificationDisputeProcessIdParamsSchema,
        body: PlatformCivicVerificationDisputeResolveBodySchema,
        response: PlatformCivicModerationRouteResponses.resolveVerificationDispute,
      },
    },
    async (request, reply) => {
      const operator = await requireOperator(request, 'moderate_civic_process');
      if (!operator) {
        reply.callNotFound();
        return;
      }
      const nowIso = now();
      const changed = await resolveCivicVerificationDispute(app.database.db, {
        processId: request.params.processId,
        outcome: request.body.outcome,
        resolvedByAccountId: operator.accountId,
        resolvedAt: nowIso,
        reviewNote: request.body.reviewNote ?? null,
      });
      if (changed) {
        await audit(operator.accountId, 'civic_verification_dispute_resolved', request.id, {
          metadata: { processId: request.params.processId, outcome: request.body.outcome },
        });
      }
      const existing = changed
        ? null
        : await findCivicVerificationDisputeResolution(app.database.db, request.params.processId);
      return {
        data: {
          processId: request.params.processId,
          outcome: changed ? request.body.outcome : (existing?.outcome ?? request.body.outcome),
          resolvedAt: changed
            ? toIsoTimestamp(nowIso)
            : existing
              ? toIsoTimestamp(existing.resolvedAt)
              : null,
          changed,
        },
      };
    },
  );

  done();
};

const PLATFORM_AUDIT_ACTIONS = new Set<PlatformAuditAction>([
  'operator_granted',
  'operator_revoked',
  'operator_role_changed',
  'account_suspended',
  'account_reactivated',
  'signal_hidden',
  'signal_unhidden',
  'status_viewed',
  'account_inspected',
  'audit_inspected',
  'email_inspected',
  'payment_inspected',
  'membership_granted',
  'membership_extended',
  'membership_cancellation_scheduled',
  'submission_rejected',
  'submission_restored',
  'discussion_contribution_hidden',
  'discussion_contribution_unhidden',
  'technical_errors_inspected',
  'uptime_inspected',
  'alerts_inspected',
  'alert_acknowledged',
  'backup_inspected',
  'backup_verified',
  'restore_inspected',
  'restore_drill_attested',
  'investigation_exported',
  'civic_content_hidden',
  'civic_content_unhidden',
  'civic_contestation_resolved',
  'civic_verification_dispute_resolved',
]);

function isPlatformAuditAction(value: string): value is PlatformAuditAction {
  return PLATFORM_AUDIT_ACTIONS.has(value as PlatformAuditAction);
}
