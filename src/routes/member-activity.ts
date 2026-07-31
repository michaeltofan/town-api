import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { Env } from '../config/env.js';
import { requirePasskeyManagementConfig } from '../ceremony/passkey-management/config.js';
import {
  parseSessionAuthorizationHeader,
  parseWebSessionCookie,
  type SessionTransportExtraction,
} from '../ceremony/passkey-authentication/session-transport.js';
import { resolveActiveSession } from '../ceremony/passkey-authentication/service.js';
import { AppError } from '../errors/app-error.js';
import {
  isMembershipInventoryThrottled,
  recordMembershipInventoryAttempt,
} from '../membership/rate-limits.js';
import { getMemberActivityView } from '../membership/member-activity-service.js';
import { MemberActivityResponseSchema } from '../membership/member-activity-schemas.js';
import { DomainErrorResponseSchema } from '../schemas/error.js';

export type MemberActivityRoutesOptions = {
  env: Env;
  now?: () => string;
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

/**
 * Authenticated member Activity — durable confirmations, contributions,
 * authored signals, and evolution of signals the member participates in.
 * Never invents demo rows or browser-only state.
 */
export const memberActivityRoutes: FastifyPluginCallbackTypebox<MemberActivityRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { env } = options;
  const now = () => (options.now ?? (() => new Date().toISOString()))();

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
    // Read-only: web CSRF not required (same as GET membership).
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
    '/v1/account/activity',
    {
      schema: {
        tags: ['Account'],
        summary: 'Read the authenticated member civic Activity feed',
        description:
          'Returns the authenticated account’s real civic Activity from durable backend rows only: own confirmations, own published discussion contributions, own published member signals, and current evolution (status/latest update) for signals the member participates in. Hidden signals are excluded. Never invents demo/example rows. Requires an active web or mobile session. SetupGrant, RecoveryGrant, and Bearer are rejected.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        response: {
          200: MemberActivityResponseSchema,
          401: DomainErrorResponseSchema,
          429: DomainErrorResponseSchema,
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

      const view = await getMemberActivityView(app.database.db, {
        accountId: session.accountId,
      });
      return await reply.status(200).send({ data: view });
    },
  );

  done();
};
