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
import { hideSignal, unhideSignal } from '../db/repositories/signals.js';
import type { SignalHideReason, SignalRow } from '../db/schema.js';
import { lockAccountById } from '../identity/repositories/accounts.js';
import { appendIdentitySecurityEvent } from '../identity/repositories/security-events.js';
import { toIsoTimestamp } from '../lib/timestamps.js';
import { signalNotFoundError } from '../errors/app-error.js';
import { SignalIdParamsSchema } from '../schemas/signals.js';
import {
  SignalHideBodySchema,
  SignalModerationResponseSchema,
  SignalUnhideBodySchema,
} from '../schemas/signal-moderation.js';
import { DomainErrorResponseSchema } from '../schemas/error.js';

export type SignalModerationRoutesOptions = {
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

function toModerationResponse(input: { signal: SignalRow; changed: boolean }): {
  data: {
    signalId: string;
    hidden: boolean;
    hiddenAt: string | null;
    hiddenReason: SignalHideReason | null;
    changed: boolean;
  };
} {
  const hidden = input.signal.hiddenAt !== null;
  return {
    data: {
      signalId: input.signal.id,
      hidden,
      hiddenAt: input.signal.hiddenAt === null ? null : toIsoTimestamp(input.signal.hiddenAt),
      hiddenReason: (input.signal.hiddenReason as SignalHideReason | null) ?? null,
      changed: input.changed,
    },
  };
}

/**
 * Owner-only signal hide / un-hide.
 *
 * Authz: active session AND locked account row with is_owner=true.
 * Non-owner and no-session callers receive generic NOT_FOUND (same as unknown
 * routes) so the owner-only surface is not revealed.
 *
 * Idempotency:
 * - Hide when already hidden: 200, changed=false; original who/when/why preserved; no audit.
 * - Unhide when already visible: 200, changed=false; no audit.
 * - State-changing hide/unhide: 200, changed=true; audit event written.
 */
export const signalModerationRoutes: FastifyPluginCallbackTypebox<SignalModerationRoutesOptions> = (
  app,
  options,
  done,
) => {
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

  app.post(
    '/v1/signals/:signalId/hide',
    {
      schema: {
        tags: ['SignalModeration'],
        summary: 'Hide a signal (owner only)',
        description:
          'Owner-only. Takes a fixed reason category. Hidden signals disappear from list, detail, and confirmation published lookups. Idempotent: re-hiding preserves the original who/when/why and returns changed=false.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalIdParamsSchema,
        body: SignalHideBodySchema,
        response: {
          200: SignalModerationResponseSchema,
          400: DomainErrorResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const accountId = await resolveOwnerAccountId(request);
      if (!accountId) {
        reply.callNotFound();
        return;
      }

      const nowIso = now();
      const result = await app.database.db.transaction(async (tx) => {
        const lockedAccount = await lockAccountById(tx, accountId);
        if (!lockedAccount?.isOwner || lockedAccount.status !== 'active') {
          return { kind: 'not_owner' as const };
        }

        const hideResult = await hideSignal(tx, {
          signalId: request.params.signalId,
          reason: request.body.reason,
          hiddenByAccountId: lockedAccount.id,
          at: nowIso,
        });
        if (!hideResult) {
          return { kind: 'missing' as const };
        }

        if (hideResult.changed) {
          await appendIdentitySecurityEvent(tx, {
            id: generateId(),
            accountId: lockedAccount.id,
            eventType: 'signal_hidden',
            occurredAt: nowIso,
            requestId: request.id,
            metadata: {
              signalId: hideResult.signal.id,
              reason: request.body.reason,
            },
          });
        }

        return { kind: 'ok' as const, hideResult };
      });

      if (result.kind === 'not_owner') {
        reply.callNotFound();
        return;
      }
      if (result.kind === 'missing') {
        throw signalNotFoundError();
      }
      return toModerationResponse(result.hideResult);
    },
  );

  app.post(
    '/v1/signals/:signalId/unhide',
    {
      schema: {
        tags: ['SignalModeration'],
        summary: 'Un-hide a signal (owner only)',
        description:
          'Owner-only. Clears hidden_at/reason/by. Idempotent: un-hiding an already-visible signal returns changed=false with no audit write.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalIdParamsSchema,
        body: SignalUnhideBodySchema,
        response: {
          200: SignalModerationResponseSchema,
          400: DomainErrorResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const accountId = await resolveOwnerAccountId(request);
      if (!accountId) {
        reply.callNotFound();
        return;
      }

      const nowIso = now();
      const result = await app.database.db.transaction(async (tx) => {
        const lockedAccount = await lockAccountById(tx, accountId);
        if (!lockedAccount?.isOwner || lockedAccount.status !== 'active') {
          return { kind: 'not_owner' as const };
        }

        const unhideResult = await unhideSignal(tx, {
          signalId: request.params.signalId,
          at: nowIso,
        });
        if (!unhideResult) {
          return { kind: 'missing' as const };
        }

        if (unhideResult.changed) {
          await appendIdentitySecurityEvent(tx, {
            id: generateId(),
            accountId: lockedAccount.id,
            eventType: 'signal_unhidden',
            occurredAt: nowIso,
            requestId: request.id,
            metadata: {
              signalId: unhideResult.signal.id,
            },
          });
        }

        return { kind: 'ok' as const, unhideResult };
      });

      if (result.kind === 'not_owner') {
        reply.callNotFound();
        return;
      }
      if (result.kind === 'missing') {
        throw signalNotFoundError();
      }
      return toModerationResponse(result.unhideResult);
    },
  );

  done();
};
