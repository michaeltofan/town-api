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
  ensureParticipantSignalConfirmation,
  findActiveCivicActorByAccountId,
  getActorConfirmationState,
} from '../db/repositories/confirmations.js';
import { findPublishedSignalById } from '../db/repositories/signals.js';
import { findAccountById } from '../identity/repositories/accounts.js';
import { appendIdentitySecurityEvent } from '../identity/repositories/security-events.js';
import { toIsoTimestamp } from '../lib/timestamps.js';
import { assertControlledAccess } from '../plugins/controlled-access.js';
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
    createDefaultLocalEligibilityResolver({ nodeEnv: env.NODE_ENV });

  app.get(
    '/v1/signals/:signalId/confirmation',
    {
      schema: {
        tags: ['Confirmations'],
        summary: 'Get controlled confirmation state for a published signal',
        description:
          'Temporary controlled test mechanism using X-TOWN-Control-Key. This is not public authentication. Returns actor-specific confirmation state for the configured controlled test actor. No public counts or actor identifiers are exposed.',
        security: [{ TownControlKey: [] }],
        params: SignalIdParamsSchema,
        response: {
          200: ConfirmationResponseSchema,
          400: DomainErrorResponseSchema,
          401: DomainErrorResponseSchema,
          403: DomainErrorResponseSchema,
          404: DomainErrorResponseSchema,
        },
      },
      preHandler: async (request, reply) => {
        assertControlledAccess(request, reply, env);
        if (reply.sent) {
          return reply;
        }
      },
    },
    async (request, reply) => {
      if (reply.sent) {
        return;
      }

      const actorId = requireConfiguredActorId(env);
      const state = await getActorConfirmationState(
        app.database.db,
        actorId,
        request.params.signalId,
      );

      return {
        data: {
          signalId: state.signalId,
          confirmed: state.confirmed,
          confirmedAt: state.confirmedAt === null ? null : toIsoTimestamp(state.confirmedAt),
        },
      };
    },
  );

  async function requireSession(request: {
    headers: {
      authorization?: string | string[] | undefined;
      origin?: string | string[] | undefined;
      'sec-fetch-site'?: string | string[] | undefined;
    };
    cookies?: Record<string, string | undefined>;
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
    if (extracted.clientType === 'web') {
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

  app.put(
    '/v1/signals/:signalId/confirmation',
    {
      schema: {
        tags: ['Confirmations'],
        summary: 'Confirm a published signal as an authenticated civic participant',
        description:
          'Requires an active web or mobile session. The account must have participant civic access derived from an active membership entitlement, a linked civic actor for the signal community, and fail-closed local eligibility. SetupGrant, RecoveryGrant, Bearer, and the temporary X-TOWN-Control-Key are rejected. Idempotent: repeats return the same confirmedAt. Body must be empty. Never exposes actor identifiers, counts, or Stripe provider identifiers. Denials emit CIVIC_PARTICIPATION_NOT_AUTHORIZED without leaking the specific reason.',
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
      });

      const signalId = request.params.signalId;
      const published = await findPublishedSignalById(app.database.db, signalId);
      if (!published) {
        throw signalNotFoundError();
      }

      const communityId = published.signal.communityId;
      const [account, entitlement, actor] = await Promise.all([
        findAccountById(app.database.db, session.accountId),
        findEntitlementByAccountId(app.database.db, session.accountId),
        findActiveCivicActorByAccountId(app.database.db, session.accountId),
      ]);

      const nowIso = now();
      const localEligibility = actor?.communityId
        ? await Promise.resolve(
            resolver({
              accountId: session.accountId,
              actorId: actor.id,
              communityId: actor.communityId,
            }),
          )
        : 'not_verified';

      const access = evaluateCivicAccess({
        session: { accountId: session.accountId },
        account: account ? { id: account.id, status: account.status } : null,
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
          accountId: session.accountId,
          eventType: 'civic_participation_denied',
          occurredAt: nowIso,
          requestId: request.id,
          metadata: {
            denialReason,
          },
        });
        throw civicParticipationNotAuthorizedError();
      }

      if (!actor) {
        // Defense in depth: evaluateCivicAccess should have denied.
        throw civicParticipationNotAuthorizedError();
      }

      const result = await ensureParticipantSignalConfirmation(app.database.db, actor.id, signalId);

      return await reply.status(200).send({
        data: {
          signalId: result.signalId,
          confirmed: true,
          confirmedAt: toIsoTimestamp(result.confirmation.confirmedAt),
        },
      });
    },
  );

  done();
};
