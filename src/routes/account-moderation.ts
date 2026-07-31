import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env.js';
import { requirePasskeyManagementConfig } from '../ceremony/passkey-management/config.js';
import { assertWebCookieCsrf } from '../ceremony/passkey-authentication/csrf.js';
import {
  parseSessionAuthorizationHeader,
  parseWebSessionCookie,
  type SessionTransportExtraction,
} from '../ceremony/passkey-authentication/session-transport.js';
import { resolveActiveSession } from '../ceremony/passkey-authentication/service.js';
import { revokeAllAccountSessions } from '../ceremony/repositories/account-sessions.js';
import type { AccountRow, AccountStatus } from '../db/schema.js';
import {
  findAccountById,
  listSuspendedAccountsForOwnerModeration,
  lockAccountById,
  transitionAccountState,
} from '../identity/repositories/accounts.js';
import { appendIdentitySecurityEvent } from '../identity/repositories/security-events.js';
import { toIsoTimestamp } from '../lib/timestamps.js';
import {
  accountNotFoundError,
  cannotBanOwnerError,
  cannotBanSelfError,
} from '../errors/app-error.js';
import {
  AccountBanBodySchema,
  AccountIdParamsSchema,
  AccountModerationResponseSchema,
  AccountUnbanBodySchema,
  SuspendedAccountsModerationResponseSchema,
} from '../schemas/account-moderation.js';
import { DomainErrorResponseSchema } from '../schemas/error.js';

export type AccountModerationRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
};

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function extractSessionTransport(input: {
  authorization: string | string[] | undefined;
  cookieName: string;
  cookies: Record<string, string | undefined> | undefined;
}): SessionTransportExtraction {
  const web = parseWebSessionCookie({
    cookieName: input.cookieName,
    cookies: input.cookies,
  });
  if (web.ok) {
    return web;
  }
  return parseSessionAuthorizationHeader(input.authorization);
}

function rejectNonSessionSchemes(authorization: string | string[] | undefined): boolean {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  if (raw === undefined || raw.length === 0) {
    return false;
  }
  const space = raw.indexOf(' ');
  if (space <= 0) {
    return false;
  }
  const scheme = raw.slice(0, space);
  return scheme === 'SetupGrant' || scheme === 'RecoveryGrant' || scheme === 'Bearer';
}

function toModerationResponse(input: { account: AccountRow; changed: boolean }): {
  data: {
    accountId: string;
    status: AccountStatus;
    suspendedAt: string | null;
    changed: boolean;
  };
} {
  return {
    data: {
      accountId: input.account.id,
      status: input.account.status as AccountStatus,
      suspendedAt:
        input.account.suspendedAt === null ? null : toIsoTimestamp(input.account.suspendedAt),
      changed: input.changed,
    },
  };
}

/**
 * Owner-only account ban (suspend) / un-ban (reactivate).
 *
 * Authz: active session AND locked account row with is_owner=true (never from
 * session/request body/header claims). Non-owner and no-session callers receive
 * generic NOT_FOUND so the owner-only surface is not revealed.
 *
 * Ban (active -> suspended): atomically transitions status, revokes all active
 * sessions (reason account_suspended), and writes ONE account_suspended audit
 * with reason in metadata. Does not touch signals/confirmations/submissions or
 * membership entitlement.
 *
 * Un-ban (suspended -> active): transitions status and writes ONE account_activated
 * audit. Does NOT restore revoked sessions — the member logs in again normally.
 *
 * Idempotency / no-ops (200, changed=false, no audit, no state corruption):
 * - Ban when already suspended
 * - Ban when not currently active (pending_email, pending_passkey, closed)
 * - Un-ban when not currently suspended (including already active)
 *
 * Guards: owner cannot ban self or another owner (403, no state change).
 */
export const accountModerationRoutes: FastifyPluginCallbackTypebox<
  AccountModerationRoutesOptions
> = (app, options, done) => {
  const { env } = options;
  const now = () => (options.now ?? (() => new Date().toISOString()))();
  const generateId = options.generateId ?? (() => randomUUID());

  async function resolveOwnerAccountId(request: {
    headers: {
      authorization?: string | string[] | undefined;
      origin?: string | string[] | undefined;
      'sec-fetch-site'?: string | string[] | undefined;
    };
    cookies?: Record<string, string | undefined>;
  }): Promise<string | null> {
    if (rejectNonSessionSchemes(request.headers.authorization)) {
      return null;
    }

    let config;
    try {
      config = requirePasskeyManagementConfig(env);
    } catch {
      return null;
    }

    const extracted = extractSessionTransport({
      authorization: request.headers.authorization,
      cookieName: config.webSessionCookieName,
      cookies: request.cookies,
    });
    if (!extracted.ok) {
      return null;
    }
    if (extracted.clientType === 'web') {
      const csrf = assertWebCookieCsrf({
        originHeader: singleHeader(request.headers.origin),
        secFetchSite: singleHeader(request.headers['sec-fetch-site']),
        allowedOrigins: config.allowedOrigins,
      });
      if (!csrf.ok) {
        return null;
      }
    }

    const session = await resolveActiveSession(
      app.database.db,
      { env, now },
      {
        clientType: extracted.clientType,
        token: extracted.token,
      },
    );
    if (!session) {
      return null;
    }
    return session.accountId;
  }

  /**
   * Lock owner + target in deterministic id order to avoid deadlocks, then
   * return the locked rows keyed by role.
   */
  async function lockOwnerAndTarget(
    tx: Parameters<typeof lockAccountById>[0],
    ownerAccountId: string,
    targetAccountId: string,
  ): Promise<
    | { kind: 'not_owner' }
    | { kind: 'missing_target' }
    | { kind: 'ok'; owner: AccountRow; target: AccountRow }
  > {
    const orderedIds =
      ownerAccountId === targetAccountId
        ? [ownerAccountId]
        : [ownerAccountId, targetAccountId].sort((a, b) => a.localeCompare(b));

    const lockedById = new Map<string, AccountRow>();
    for (const id of orderedIds) {
      const row = await lockAccountById(tx, id);
      if (row) {
        lockedById.set(id, row);
      }
    }

    const owner = lockedById.get(ownerAccountId);
    if (!owner?.isOwner || owner.status !== 'active') {
      return { kind: 'not_owner' };
    }

    const target = lockedById.get(targetAccountId);
    if (!target) {
      return { kind: 'missing_target' };
    }

    return { kind: 'ok', owner, target };
  }

  app.post(
    '/v1/accounts/:accountId/ban',
    {
      schema: {
        tags: ['AccountModeration'],
        summary: 'Ban (suspend) an account (owner only)',
        description:
          'Owner-only. Suspends the target account (status active -> suspended), revokes all of its active sessions (reason account_suspended), and writes one account_suspended audit with a fixed reason category. Idempotent: re-banning an already-suspended account returns changed=false with no audit. Ban of a non-active account (pending/closed) is a no-op (changed=false). Cannot ban self or another owner.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: AccountIdParamsSchema,
        body: AccountBanBodySchema,
        response: {
          200: AccountModerationResponseSchema,
          400: DomainErrorResponseSchema,
          403: DomainErrorResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const ownerAccountId = await resolveOwnerAccountId(request);
      if (!ownerAccountId) {
        reply.callNotFound();
        return;
      }

      const targetAccountId = request.params.accountId;
      const nowIso = now();
      const result = await app.database.db.transaction(async (tx) => {
        const locked = await lockOwnerAndTarget(tx, ownerAccountId, targetAccountId);
        if (locked.kind === 'not_owner') {
          return { kind: 'not_owner' as const };
        }
        if (locked.kind === 'missing_target') {
          return { kind: 'missing' as const };
        }

        const { owner, target } = locked;

        if (target.id === owner.id) {
          return { kind: 'ban_self' as const };
        }
        if (target.isOwner) {
          return { kind: 'ban_owner' as const };
        }

        // Already suspended or otherwise not active: safe no-op, no audit.
        if (target.status !== 'active') {
          return { kind: 'ok' as const, account: target, changed: false };
        }

        const suspended = await transitionAccountState(tx, {
          accountId: target.id,
          to: 'suspended',
          at: nowIso,
        });

        // Revoke sessions without writing a separate session_revoked audit —
        // the single account_suspended event is the durable ban record.
        await revokeAllAccountSessions(tx, {
          accountId: target.id,
          reason: 'account_suspended',
          now: nowIso,
        });

        await appendIdentitySecurityEvent(tx, {
          id: generateId(),
          accountId: owner.id,
          eventType: 'account_suspended',
          occurredAt: nowIso,
          requestId: request.id,
          metadata: {
            targetAccountId: target.id,
            reason: request.body.reason,
          },
        });

        return { kind: 'ok' as const, account: suspended, changed: true };
      });

      if (result.kind === 'not_owner') {
        reply.callNotFound();
        return;
      }
      if (result.kind === 'missing') {
        throw accountNotFoundError();
      }
      if (result.kind === 'ban_self') {
        throw cannotBanSelfError();
      }
      if (result.kind === 'ban_owner') {
        throw cannotBanOwnerError();
      }
      return toModerationResponse(result);
    },
  );

  app.post(
    '/v1/accounts/:accountId/unban',
    {
      schema: {
        tags: ['AccountModeration'],
        summary: 'Un-ban (reactivate) an account (owner only)',
        description:
          'Owner-only. Reactivates a suspended account (status suspended -> active) and writes one account_activated audit. Does not restore previously revoked sessions — the member must log in again. Idempotent: un-banning a non-suspended account returns changed=false with no audit.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: AccountIdParamsSchema,
        body: AccountUnbanBodySchema,
        response: {
          200: AccountModerationResponseSchema,
          400: DomainErrorResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const ownerAccountId = await resolveOwnerAccountId(request);
      if (!ownerAccountId) {
        reply.callNotFound();
        return;
      }

      const targetAccountId = request.params.accountId;
      const nowIso = now();
      const result = await app.database.db.transaction(async (tx) => {
        const locked = await lockOwnerAndTarget(tx, ownerAccountId, targetAccountId);
        if (locked.kind === 'not_owner') {
          return { kind: 'not_owner' as const };
        }
        if (locked.kind === 'missing_target') {
          return { kind: 'missing' as const };
        }

        const { owner, target } = locked;

        // Not suspended (active, pending, closed, …): safe no-op, no audit.
        if (target.status !== 'suspended') {
          return { kind: 'ok' as const, account: target, changed: false };
        }

        const reactivated = await transitionAccountState(tx, {
          accountId: target.id,
          to: 'active',
          at: nowIso,
        });

        await appendIdentitySecurityEvent(tx, {
          id: generateId(),
          accountId: owner.id,
          eventType: 'account_activated',
          occurredAt: nowIso,
          requestId: request.id,
          metadata: {
            targetAccountId: target.id,
          },
        });

        return { kind: 'ok' as const, account: reactivated, changed: true };
      });

      if (result.kind === 'not_owner') {
        reply.callNotFound();
        return;
      }
      if (result.kind === 'missing') {
        throw accountNotFoundError();
      }
      return toModerationResponse(result);
    },
  );

  app.get(
    '/v1/moderation/accounts/suspended',
    {
      schema: {
        tags: ['AccountModeration'],
        summary: 'List suspended accounts for owner moderation',
        description:
          'Owner-only read surface for the existing unban tool. Returns suspended accounts with primary email when present. Non-owner and no-session callers receive generic NOT_FOUND.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        response: {
          200: SuspendedAccountsModerationResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const ownerAccountId = await resolveOwnerAccountId(request);
      if (!ownerAccountId) {
        reply.callNotFound();
        return;
      }

      const owner = await findAccountById(app.database.db, ownerAccountId);
      if (!owner?.isOwner || owner.status !== 'active') {
        reply.callNotFound();
        return;
      }

      const rows = await listSuspendedAccountsForOwnerModeration(app.database.db);
      return {
        data: {
          accounts: rows.map((row) => ({
            accountId: row.accountId,
            email: row.email,
            suspendedAt: toIsoTimestamp(row.suspendedAt),
          })),
        },
      };
    },
  );

  done();
};
