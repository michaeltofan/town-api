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
import { findActiveCivicActorByAccountId } from '../db/repositories/confirmations.js';
import {
  ensureDiscussionSessionForSignal,
  insertDiscussionContribution,
  listDiscussionContributionsForSession,
} from '../db/repositories/discussion-session.js';
import { findPublishedSignalById } from '../db/repositories/signals.js';
import { findAccountById } from '../identity/repositories/accounts.js';
import { appendIdentitySecurityEvent } from '../identity/repositories/security-events.js';
import { toIsoTimestamp } from '../lib/timestamps.js';
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
import { ERROR_CODE } from '../schemas/error.js';
import {
  DiscussionContributionBodySchema,
  DiscussionSessionRouteResponses,
  SignalIdParamsSchema,
} from '../schemas/discussion-session.js';

export type DiscussionSessionRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  localEligibilityResolver?: LocalParticipationEligibilityResolver;
};

const MIN_CONTRIBUTION_TEXT_LENGTH = 12;
const MAX_CONTRIBUTION_TEXT_LENGTH = 480;

function sessionNotAuthorizedError(): AppError {
  return new AppError(401, 'SESSION_NOT_AUTHORIZED', 'Session is not authorized.');
}

function validationError(): AppError {
  return new AppError(400, ERROR_CODE.VALIDATION_ERROR, 'Request validation failed.');
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

export const discussionSessionRoutes: FastifyPluginCallbackTypebox<
  DiscussionSessionRoutesOptions
> = (app, options, done) => {
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
    '/v1/signals/:signalId/discussion-session',
    {
      schema: {
        tags: ['Discussion'],
        summary: 'Read the civic discussion session for a published signal',
        description:
          'Returns the discussion session and ordered civic contributions for a published signal. Requires an active web or mobile session with participant civic access (access.canParticipate). Contributions are framed as movement toward a local solution (observation, proposal, or next step) — not chat, comments, or social replies. SetupGrant, RecoveryGrant, and Bearer are rejected. Never exposes actor or account identifiers.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalIdParamsSchema,
        response: DiscussionSessionRouteResponses.read,
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
        mutative: false,
      });

      const { signalId } = await requireParticipantForSignal({
        sessionAccountId: session.accountId,
        signalId: request.params.signalId,
        requestId: request.id,
      });

      const nowIso = now();
      const discussionSession = await ensureDiscussionSessionForSignal(app.database.db, {
        signalId,
        id: generateId(),
        now: nowIso,
      });
      const contributions = await listDiscussionContributionsForSession(
        app.database.db,
        discussionSession.id,
      );

      return await reply.status(200).send({
        data: {
          session: {
            id: discussionSession.id,
            signalId: discussionSession.signalId,
            createdAt: toIsoTimestamp(discussionSession.createdAt),
          },
          contributions: contributions.map((contribution) => ({
            ...contribution,
            createdAt: toIsoTimestamp(contribution.createdAt),
          })),
        },
      });
    },
  );

  app.post(
    '/v1/signals/:signalId/discussion-session/contributions',
    {
      schema: {
        tags: ['Discussion'],
        summary: 'Publish a civic contribution to a signal discussion session',
        description:
          'Creates a civic contribution (observation, proposal, or next step) on the discussion session for a published signal. Requires an active web or mobile session with participant civic access (access.canParticipate). Not a chat or comment thread. Returns the session and the full ordered contribution list. SetupGrant, RecoveryGrant, and Bearer are rejected. Never exposes actor or account identifiers.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: SignalIdParamsSchema,
        body: DiscussionContributionBodySchema,
        response: DiscussionSessionRouteResponses.contribute,
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

      const text = request.body.text.trim();
      if (
        text.length < MIN_CONTRIBUTION_TEXT_LENGTH ||
        text.length > MAX_CONTRIBUTION_TEXT_LENGTH
      ) {
        throw validationError();
      }

      const { signalId, actor } = await requireParticipantForSignal({
        sessionAccountId: session.accountId,
        signalId: request.params.signalId,
        requestId: request.id,
      });

      const nowIso = now();
      const discussionSession = await ensureDiscussionSessionForSignal(app.database.db, {
        signalId,
        id: generateId(),
        now: nowIso,
      });

      await insertDiscussionContribution(app.database.db, {
        id: generateId(),
        sessionId: discussionSession.id,
        signalId,
        actorId: actor.id,
        text,
        intent: request.body.intent,
        createdAt: nowIso,
      });

      const contributions = await listDiscussionContributionsForSession(
        app.database.db,
        discussionSession.id,
      );

      return await reply.status(201).send({
        data: {
          session: {
            id: discussionSession.id,
            signalId: discussionSession.signalId,
            createdAt: toIsoTimestamp(discussionSession.createdAt),
          },
          contributions: contributions.map((contribution) => ({
            ...contribution,
            createdAt: toIsoTimestamp(contribution.createdAt),
          })),
        },
      });
    },
  );

  done();
};
