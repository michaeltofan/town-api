import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { Env } from '../config/env.js';
import { requirePasskeyManagementConfig } from '../ceremony/passkey-management/config.js';
import { assertWebCookieCsrf } from '../ceremony/passkey-authentication/csrf.js';
import {
  parseSessionAuthorizationHeader,
  parseWebSessionCookie,
  type SessionTransportExtraction,
} from '../ceremony/passkey-authentication/session-transport.js';
import { resolveActiveSession } from '../ceremony/passkey-authentication/service.js';
import { findActiveCommunityBySlug } from '../db/repositories/communities.js';
import { findActiveCivicActorByAccountId } from '../db/repositories/confirmations.js';
import { findAccountById } from '../identity/repositories/accounts.js';
import {
  AppError,
  civicParticipationNotAuthorizedError,
  communityNotFoundError,
} from '../errors/app-error.js';
import { evaluateCivicAccess } from '../membership/civic-access.js';
import {
  createDefaultLocalEligibilityResolver,
  type LocalParticipationEligibilityResolver,
} from '../membership/local-eligibility.js';
import { findEntitlementByAccountId } from '../membership/repositories/entitlements.js';
import { ERROR_CODE } from '../schemas/error.js';
import {
  CommunitySlugParamsSchema,
  SignalSubmissionBodySchema,
  SignalSubmissionRouteResponses,
} from '../membership/signal-submission-schemas.js';
import { createSignalSubmissionInTransaction } from '../membership/signal-submission-service.js';

export type SignalSubmissionRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  localEligibilityResolver?: LocalParticipationEligibilityResolver;
};

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

export const signalSubmissionRoutes: FastifyPluginCallbackTypebox<SignalSubmissionRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { env } = options;
  const now = () => (options.now ?? (() => new Date().toISOString()))();
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

  app.post(
    '/v1/communities/:communitySlug/signal-submissions',
    {
      schema: {
        tags: ['Communities'],
        summary: 'Submit a member signal for community review (flag-gated)',
        description:
          'Session-authenticated member signal submission. Creates a pending_review row only. Gated by SIGNAL_SUBMISSION_ENABLED (default false). Requires participant civic access for the path community. Enforces a rolling 24-hour account submission cap of 5.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        params: CommunitySlugParamsSchema,
        body: SignalSubmissionBodySchema,
        response: SignalSubmissionRouteResponses.create,
      },
    },
    async (request, reply) => {
      if (!env.SIGNAL_SUBMISSION_ENABLED) {
        reply.callNotFound();
        return;
      }

      const session = await requireSession({
        headers: request.headers,
        cookies: request.cookies,
      });

      const headline = request.body.headline.trim();
      const body = request.body.body.trim();
      if (
        headline.length === 0 ||
        body.length === 0 ||
        headline.length > 160 ||
        body.length > 2000
      ) {
        throw validationError();
      }

      const community = await findActiveCommunityBySlug(
        app.database.db,
        request.params.communitySlug,
      );
      if (!community) {
        throw communityNotFoundError();
      }

      const actor = await findActiveCivicActorByAccountId(app.database.db, session.accountId);
      if (!actor) {
        throw civicParticipationNotAuthorizedError();
      }

      const nowIso = now();
      const [account, entitlement] = await Promise.all([
        findAccountById(app.database.db, session.accountId),
        findEntitlementByAccountId(app.database.db, session.accountId),
      ]);

      const localEligibility = await Promise.resolve(
        resolver({
          accountId: session.accountId,
          actorId: actor.id,
          communityId: community.id,
          actor,
        }),
      );

      const access = evaluateCivicAccess({
        session: { accountId: session.accountId },
        account: account
          ? { id: account.id, status: account.status, isOwner: account.isOwner }
          : null,
        entitlement,
        actor,
        communityId: community.id,
        localEligibility,
        now: nowIso,
      });

      if (access.level !== 'participant' || !access.canParticipate) {
        throw civicParticipationNotAuthorizedError();
      }

      const result = await app.database.db.transaction(async (tx) => {
        return createSignalSubmissionInTransaction(tx, {
          accountId: session.accountId,
          actor,
          community,
          headline,
          body,
          now: nowIso,
          ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
        });
      });

      return await reply.status(201).send({
        data: {
          id: result.id,
          status: result.status,
          community: result.community,
          createdAt: result.createdAt,
        },
      });
    },
  );

  done();
};
