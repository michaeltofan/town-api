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
import { AppError } from '../errors/app-error.js';
import {
  createDefaultLocalEligibilityResolver,
  type LocalParticipationEligibilityResolver,
} from '../membership/local-eligibility.js';
import {
  isMembershipInventoryThrottled,
  recordMembershipInventoryAttempt,
} from '../membership/rate-limits.js';
import { getAccountMembershipView } from '../membership/read-service.js';
import { MembershipRouteResponses } from '../membership/schemas.js';

export type MembershipRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  localEligibilityResolver?: LocalParticipationEligibilityResolver;
};

function sessionNotAuthorizedError(): AppError {
  return new AppError(401, 'SESSION_NOT_AUTHORIZED', 'Session is not authorized.');
}

function rateLimitedError(): AppError {
  return new AppError(429, 'RATE_LIMITED', 'Rate limit exceeded.');
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

export const membershipRoutes: FastifyPluginCallbackTypebox<MembershipRoutesOptions> = (
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

  app.get(
    '/v1/account/membership',
    {
      schema: {
        tags: ['Account'],
        summary: 'Read the authenticated account membership entitlement and civic access view',
        description:
          'Returns the effective membership status (inactive/active/cancelling/expired/paid_pending_binding), accessUntil, cancelAtPeriodEnd, the civic access level derived from membership, actor linkage, and fail-closed local eligibility, and isOwner for the authenticated account (self-only). paid_pending_binding never grants participant access. Requires an active web or mobile session. SetupGrant, RecoveryGrant, and Bearer are rejected. Never exposes Stripe customer or subscription identifiers.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        response: MembershipRouteResponses.accountMembership,
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

      const config = requirePasskeyManagementConfig(env);
      const nowIso = now();
      const throttled = await isMembershipInventoryThrottled(app.database.db, {
        rateLimitHashKey: config.rateLimitHashKey,
        accountId: session.accountId,
        now: nowIso,
      });
      await recordMembershipInventoryAttempt(app.database.db, {
        rateLimitHashKey: config.rateLimitHashKey,
        accountId: session.accountId,
        now: nowIso,
        throttled,
        requestId: request.id,
      });
      if (throttled) {
        throw rateLimitedError();
      }

      const view = await getAccountMembershipView(app.database.db, {
        accountId: session.accountId,
        session: { accountId: session.accountId },
        localEligibilityResolver: resolver,
        now: nowIso,
      });

      return await reply.status(200).send({ data: view });
    },
  );

  done();
};
