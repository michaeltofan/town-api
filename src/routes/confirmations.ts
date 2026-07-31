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
import {
  countConfirmationsForSignal,
  ensureParticipantSignalConfirmation,
  findActiveCivicActorByAccountId,
  findConfirmationByActorAndSignal,
  getActorConfirmationState,
} from '../db/repositories/confirmations.js';
import { findPublishedSignalById } from '../db/repositories/signals.js';
import { findAccountById } from '../identity/repositories/accounts.js';
import { appendIdentitySecurityEvent } from '../identity/repositories/security-events.js';
import { toIsoTimestamp } from '../lib/timestamps.js';
import { assertControlledAccess, CONTROLLED_ACCESS_HEADER } from '../plugins/controlled-access.js';
import {
  AppError,
  civicParticipationNotAuthorizedError,
  signalNotFoundError,
} from '../errors/app-error.js';
import { evaluateCivicAccess } from '../membership/civic-access.js';
import {
  createDefaultLocalEligibilityResolver,
  type LocalParticipationEligibilityResolver,
} from '../membership/local-eligibility.js';
import { findEntitlementByAccountId } from '../membership/repositories/entitlements.js';
import type { ParticipationDenialReason } from '../membership/types.js';
import { ConfirmationPutBodySchema, ConfirmationResponseSchema } from '../schemas/confirmations.js';
import { SignalIdParamsSchema } from '../schemas/signals.js';
import { DomainErrorResponseSchema } from '../schemas/error.js';

export type ConfirmationRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  localEligibilityResolver?: LocalParticipationEligibilityResolver;
};

function requireConfiguredActorId(env: Env): string {
  const actorId = env.CONTROLLED_TEST_ACTOR_ID;
  if (actorId === undefined) {
    throw new Error('Controlled confirmation setup is invalid');
  }
  return actorId;
}

function sessionNotAuthorizedError(): AppError {
  return new AppError(401, 'SESSION_NOT_AUTHORIZED', 'Session is not authorized.');
}

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

function rejectNonSessionSchemes(authorization: string | string[] | undefined): void {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  if (raw === undefined || raw.length === 0) {
    return;
  }
  const space = raw.indexOf(' ');
  if (space <= 0) {
    return;
  }
  const scheme = raw.slice(0, space);
  if (scheme === 'SetupGrant' || scheme === 'RecoveryGrant' || scheme === 'Bearer') {
    throw sessionNotAuthorizedError();
  }
}

function assertWebCsrf(input: {
  originHeader: string | undefined;
  secFetchSite: string | undefined;
  allowedOrigins: readonly string[];
}): void {
  const csrf = assertWebCookieCsrf(input);
  if (!csrf.ok) {
    throw sessionNotAuthorizedError();
  }
}

function hasControlKeyHeader(headers: {
  authorization?: string | string[] | undefined;
  [key: string]: string | string[] | undefined;
}): boolean {
  const supplied = singleHeader(headers[CONTROLLED_ACCESS_HEADER]);
  return typeof supplied === 'string' && supplied.length > 0;
}

export const confirmationRoutes: FastifyPluginCallbackTypebox<ConfirmationRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { env } = options;
  const now = () => (options.now ?? (() => new Date().toISOString()))();
  const generateId = options.generateId ?? (() => randomUUID());
  const resolver: LocalParticipationEligibilityResolver =
    options.localEligibilityResolver ??
    createDefaultLocalEligibilityResolver({
      localEligibilityEnabled: env.LOCAL_ELIGIBILITY_ENABLED,
    });

  async function requireSession(request: {
    headers: {
      authorization?: string | string[] | undefined;
      origin?: string | string[] | undefined;
      'sec-fetch-site'?: string | string[] | undefined;
    };
    cookies?: Record<string, string | undefined>;
    mutative?: boolean;
  }): Promise<NonNullable<Awaited<ReturnType<typeof resolveActiveSession>>>> {
    rejectNonSessionSchemes(request.headers.authorization);
    const config = requirePasskeyManagementConfig(env);
    const extracted = extractSessionTransport({
      authorization: request.headers.authorization,
      cookieName: config.webSessionCookieName,
      cookies: request.cookies,
    });
    if (!extracted.ok) {
      throw sessionNotAuthorizedError();
    }
    if (extracted.clientType === 'web' && request.mutative !== false) {
      assertWebCsrf({
        originHeader: singleHeader(request.headers.origin),
        secFetchSite: singleHeader(request.headers['sec-fetch-site']),
        allowedOrigins: config.allowedOrigins,
      });
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
      throw sessionNotAuthorizedError();
    }
    return session;
  }

  async function requireParticipantForSignal(input: {
    sessionAccountId: string;
    signalId: string;
    requestId: string;
  }): Promise<{
    signalId: string;
    actor: NonNullable<Awaited<ReturnType<typeof findActiveCivicActorByAccountId>>>;
  }> {
    const published = await findPublishedSignalById(app.database.db, input.signalId);
    if (!published) {
      throw signalNotFoundError();
    }

    const communityId = published.signal.communityId;
    const [account, entitlement, actor] = await Promise.all([
      findAccountById(app.database.db, input.sessionAccountId),
      findEntitlementByAccountId(app.database.db, input.sessionAccountId),
      findActiveCivicActorByAccountId(app.database.db, input.sessionAccountId),
    ]);

    const nowIso = now();
    const localEligibility = actor?.communityId
      ? await Promise.resolve(
          resolver({
            accountId: input.sessionAccountId,
            actorId: actor.id,
            communityId: actor.communityId,
            actor,
          }),
        )
      : 'not_verified';

    const access = evaluateCivicAccess({
      session: { accountId: input.sessionAccountId },
      account: account
        ? { id: account.id, status: account.status, isOwner: account.isOwner }
        : null,
      entitlement,
      actor,
      communityId,
      localEligibility,
      now: nowIso,
    });

    if (access.level !== 'participant' || !access.canParticipate) {
      const denialReason: ParticipationDenialReason = access.denialReason ?? 'inactive_account';
      await appendIdentitySecurityEvent(app.database.db, {
        id: generateId(),
        accountId: input.sessionAccountId,
        eventType: 'civic_participation_denied',
        occurredAt: nowIso,
        requestId: input.requestId,
        metadata: {
          denialReason,
        },
      });
      throw civicParticipationNotAuthorizedError();
    }

    if (!actor) {
      throw civicParticipationNotAuthorizedError();
    }

    return { signalId: published.signal.id, actor };
  }

  app.get(
    '/v1/signals/:signalId/confirmation',
    {
      schema: {
        tags: ['Confirmations'],
        summary: 'Read confirmation state for a published signal',
        description:
          'Session-authenticated participants receive their own confirmation state plus the aggregate confirmationCount for the signal. When X-TOWN-Control-Key is supplied instead, returns the historical controlled-test-actor state (temporary testing mechanism, not public authentication). Never exposes actor identifiers or confirmer lists — only a boolean personal state and an integer aggregate total.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }, { TownControlKey: [] }],
        params: SignalIdParamsSchema,
        response: {
          200: ConfirmationResponseSchema,
          400: DomainErrorResponseSchema,
          401: DomainErrorResponseSchema,
          403: DomainErrorResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Prefer the historical controlled-key path when the header is present.
      if (hasControlKeyHeader(request.headers)) {
        assertControlledAccess(request, reply, env);
        if (reply.sent) {
          return;
        }

        const actorId = requireConfiguredActorId(env);
        const state = await getActorConfirmationState(
          app.database.db,
          actorId,
          request.params.signalId,
        );
        const confirmationCount = await countConfirmationsForSignal(
          app.database.db,
          state.signalId,
        );

        return {
          data: {
            signalId: state.signalId,
            confirmed: state.confirmed,
            confirmedAt: state.confirmedAt === null ? null : toIsoTimestamp(state.confirmedAt),
            confirmationCount,
          },
        };
      }

      if (!env.PASSKEY_AUTHENTICATION_ENABLED) {
        // Preserve controlled-key-only behavior when sessions are disabled and
        // no control key was supplied: same 401 CONTROLLED_ACCESS_REQUIRED.
        assertControlledAccess(request, reply, env);
        return;
      }

      const session = await requireSession({
        headers: request.headers,
        cookies: request.cookies,
        mutative: false,
      });

      const { signalId, actor } = await requireParticipantForSignal({
        sessionAccountId: session.accountId,
        signalId: request.params.signalId,
        requestId: request.id,
      });

      const [confirmation, confirmationCount] = await Promise.all([
        findConfirmationByActorAndSignal(app.database.db, actor.id, signalId),
        countConfirmationsForSignal(app.database.db, signalId),
      ]);

      return await reply.status(200).send({
        data: {
          signalId,
          confirmed: confirmation !== null,
          confirmedAt: confirmation === null ? null : toIsoTimestamp(confirmation.confirmedAt),
          confirmationCount,
        },
      });
    },
  );

  app.put(
    '/v1/signals/:signalId/confirmation',
    {
      schema: {
        tags: ['Confirmations'],
        summary: 'Confirm a published signal as an authenticated civic participant',
        description:
          'Requires an active web or mobile session. The account must have participant civic access derived from an active membership entitlement, a linked civic actor for the signal community, and fail-closed local eligibility. SetupGrant, RecoveryGrant, Bearer, and the temporary X-TOWN-Control-Key are rejected. Idempotent: repeats return the same confirmedAt. Body must be empty. Returns the caller confirmation state plus aggregate confirmationCount. Never exposes actor identifiers or confirmer lists. Denials emit CIVIC_PARTICIPATION_NOT_AUTHORIZED without leaking the specific reason.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalIdParamsSchema,
        body: ConfirmationPutBodySchema,
        response: {
          200: ConfirmationResponseSchema,
          400: DomainErrorResponseSchema,
          401: DomainErrorResponseSchema,
          403: DomainErrorResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!env.PASSKEY_AUTHENTICATION_ENABLED) {
        reply.callNotFound();
        return;
      }

      const session = await requireSession({
        headers: request.headers,
        cookies: request.cookies,
        mutative: true,
      });

      const { signalId, actor } = await requireParticipantForSignal({
        sessionAccountId: session.accountId,
        signalId: request.params.signalId,
        requestId: request.id,
      });

      const result = await ensureParticipantSignalConfirmation(app.database.db, actor.id, signalId);
      const confirmationCount = await countConfirmationsForSignal(app.database.db, result.signalId);

      return await reply.status(200).send({
        data: {
          signalId: result.signalId,
          confirmed: true,
          confirmedAt: toIsoTimestamp(result.confirmation.confirmedAt),
          confirmationCount,
        },
      });
    },
  );

  done();
};
