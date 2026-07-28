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
import { AppError, communityNotFoundError } from '../errors/app-error.js';
import { bindLocalEligibilityInTransaction } from '../membership/bind-service.js';
import { maybeFinalizePaidPendingBindingAfterCommunityBind } from '../membership/finalize-after-community-bind.js';
import {
  LocalEligibilityBindBodySchema,
  LocalEligibilityRouteResponses,
} from '../membership/local-eligibility-schemas.js';
import {
  isLocalEligibilityBindThrottled,
  recordLocalEligibilityBindAttempt,
} from '../membership/rate-limits.js';

export type LocalEligibilityRoutesOptions = {
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

export const localEligibilityRoutes: FastifyPluginCallbackTypebox<LocalEligibilityRoutesOptions> = (
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
    '/v1/account/eligibility',
    {
      schema: {
        tags: ['Account'],
        summary: 'Bind local participation eligibility to an active community (set-once; owners may transfer)',
        description:
          "SET-ONCE SEMANTICS (non-owners): this is deliberately not a replacing PUT for ordinary accounts. If the account has no community binding, the binding is created. If a binding already exists for the same community the request is idempotent and verifiedAt is NOT refreshed. If a binding exists for a different community the request is rejected with 409 LOCAL_ELIGIBILITY_ALREADY_BOUND.\n\nOWNER EXEMPTION: accounts with accounts.is_owner=true may transfer to a different community on this same endpoint. On owner transfer, community_id is updated and local_eligibility_verified_at is refreshed to the bind time. Owner is determined only from the locked account row — never from the request body or client-supplied claims. Non-owners keep the set-once / 409 rule unchanged.\n\nAfter a successful community binding (create, same-community idempotent confirm, or owner transfer), if the account has a durable Google Play entitlement in status paid_pending_binding, the server attempts a dedicated finalize_paid_pending_binding membership transition to active via the existing membership source-event idempotency ledger. Google Play purchase ingress remains paid_pending_binding-only; finalisation is a separate step and does not process RTDN, voided purchases, refunds, or renewals.\n\nTRUST LIMITATION: the community in the request body is a client assertion. Local eligibility is determined on the client device and raw location data never reaches the server, so the server cannot independently validate the claim. Any session holder can assert any active community slug. This capability is gated behind LOCAL_ELIGIBILITY_ENABLED, which must remain false in any environment reachable by untrusted clients until either the server can validate eligibility evidence independently of the client's claim, or access is technically restricted to approved test accounts or a separate controlled environment.",
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        body: LocalEligibilityBindBodySchema,
        response: LocalEligibilityRouteResponses.bind,
      },
    },
    async (request, reply) => {
      if (!env.LOCAL_ELIGIBILITY_ENABLED) {
        reply.callNotFound();
        return;
      }
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
      const throttled = await isLocalEligibilityBindThrottled(app.database.db, {
        rateLimitHashKey: config.rateLimitHashKey,
        accountId: session.accountId,
        now: nowIso,
      });
      await recordLocalEligibilityBindAttempt(app.database.db, {
        rateLimitHashKey: config.rateLimitHashKey,
        accountId: session.accountId,
        now: nowIso,
        throttled,
        requestId: request.id,
      });
      if (throttled) {
        throw rateLimitedError();
      }

      const community = await findActiveCommunityBySlug(app.database.db, request.body.community);
      if (!community) {
        throw communityNotFoundError();
      }

      const result = await app.database.db.transaction(async (tx) => {
        return bindLocalEligibilityInTransaction(tx, {
          accountId: session.accountId,
          community,
          now: nowIso,
        });
      });

      // Separate step after durable community binding. Never widens activate.
      // Skips when entitlement is absent or not paid_pending_binding.
      await maybeFinalizePaidPendingBindingAfterCommunityBind(
        app.database.db,
        {
          accountId: session.accountId,
          communityId: community.id,
          effectiveAt: nowIso,
        },
        {
          requestId: request.id,
          processedAt: nowIso,
        },
      );

      return await reply.status(200).send({ data: result });
    },
  );

  done();
};
