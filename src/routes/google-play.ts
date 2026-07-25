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
import {
  AppError,
  googlePlayBillingNotAvailableError,
  googlePlayPurchaseAcknowledgeFailedError,
  googlePlayPurchaseAlreadyBoundError,
  googlePlayPurchaseRejectedError,
  membershipAlreadyActiveError,
} from '../errors/app-error.js';
import { toIsoTimestamp } from '../lib/timestamps.js';
import type { TownGooglePlayAndroidPublisherAdapter } from '../membership/google-play/android-publisher-adapter.js';
import {
  createGooglePlayAndroidPublisherAdapterFromEnv,
  resolveGooglePlayVerifyPurchaseConfig,
} from '../membership/google-play/config.js';
import {
  isGooglePlayPurchaseThrottled,
  recordGooglePlayPurchaseAttempt,
} from '../membership/google-play/rate-limits.js';
import {
  GooglePlayPurchaseRequestSchema,
  GooglePlayPurchaseRouteResponses,
} from '../membership/google-play/schemas.js';
import { verifyAndProvisionGooglePlayPurchase } from '../membership/google-play/verify-and-provision.js';

export type GooglePlayRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  googlePlayAdapter?: TownGooglePlayAndroidPublisherAdapter;
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

function mapProvisionRejection(reason: string | undefined): AppError {
  switch (reason) {
    case 'purchase_token_already_correlated':
    case 'payload_hash_mismatch':
      // Same purchase token reused across accounts shares sourceEventId and fails
      // either on purchase-link uniqueness or divergent source-event payload hash.
      return googlePlayPurchaseAlreadyBoundError();
    case 'invalid_status_for_provision_paid_pending_binding':
      return membershipAlreadyActiveError();
    case 'account_closed':
      return new AppError(403, 'ACCOUNT_NOT_ELIGIBLE', 'Account is not eligible for membership.');
    default:
      return googlePlayPurchaseRejectedError();
  }
}

export const googlePlayRoutes: FastifyPluginCallbackTypebox<GooglePlayRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { env } = options;
  const nowFn = () => (options.now ?? (() => new Date().toISOString()))();
  const generateId = options.generateId;

  const resolveAdapter = (): TownGooglePlayAndroidPublisherAdapter | null => {
    if (options.googlePlayAdapter) {
      return options.googlePlayAdapter;
    }
    if (!env.GOOGLE_PLAY_BILLING_ENABLED) {
      return null;
    }
    try {
      return createGooglePlayAndroidPublisherAdapterFromEnv(env);
    } catch {
      return null;
    }
  };

  async function requireSession(request: {
    headers: {
      authorization?: string | string[] | undefined;
      origin?: string | string[] | undefined;
      'sec-fetch-site'?: string | string[] | undefined;
    };
    cookies?: Record<string, string | undefined>;
  }): Promise<{ accountId: string }> {
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
      { env, now: nowFn },
      { clientType: extracted.clientType, token: extracted.token },
    );
    if (!session) {
      throw sessionNotAuthorizedError();
    }
    return { accountId: session.accountId };
  }

  app.post(
    '/v1/billing/google-play/purchases',
    {
      schema: {
        tags: ['Billing'],
        summary: 'Verify and provision a Google Play purchase for the authenticated account',
        description:
          'Accepts a Google Play purchase token from an active web or mobile session, verifies it via Android Publisher purchases.subscriptionsv2.get, provisions paid_pending_binding through the internal Google Play provisioner, and acknowledges the purchase via purchases.subscriptions.acknowledge only after a durable applied or replayed provision outcome. Feature-gated by GOOGLE_PLAY_BILLING_ENABLED (fail-closed when disabled). SetupGrant, RecoveryGrant, and Bearer are rejected. Never returns purchase tokens, Google verification payloads, or provider identifiers. Does not process RTDN, voided purchases, refunds, or finalize binding to active.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        body: GooglePlayPurchaseRequestSchema,
        response: GooglePlayPurchaseRouteResponses.purchase,
      },
    },
    async (request, reply) => {
      if (!env.GOOGLE_PLAY_BILLING_ENABLED) {
        reply.callNotFound();
        return;
      }

      const adapter = resolveAdapter();
      const verifyConfig = resolveGooglePlayVerifyPurchaseConfig(env);
      if (!adapter || !verifyConfig.enabled) {
        throw googlePlayBillingNotAvailableError();
      }

      const { accountId } = await requireSession({
        headers: request.headers,
        cookies: request.cookies,
      });

      const config = requirePasskeyManagementConfig(env);
      const nowIso = nowFn();
      const throttled = await isGooglePlayPurchaseThrottled(app.database.db, {
        rateLimitHashKey: config.rateLimitHashKey,
        accountId,
        now: nowIso,
      });
      await recordGooglePlayPurchaseAttempt(app.database.db, {
        rateLimitHashKey: config.rateLimitHashKey,
        accountId,
        now: nowIso,
        throttled,
        requestId: request.id,
      });
      if (throttled) {
        throw rateLimitedError();
      }

      const body = request.body;
      const outcome = await verifyAndProvisionGooglePlayPurchase(
        app.database.db,
        {
          accountId,
          purchaseToken: body.purchaseToken,
          ...(body.packageName !== undefined ? { claimedPackageName: body.packageName } : {}),
          ...(body.subscriptionId !== undefined
            ? { claimedSubscriptionId: body.subscriptionId }
            : {}),
          effectiveAt: nowIso,
        },
        {
          adapter,
          config: verifyConfig,
          nodeEnv: env.NODE_ENV,
          processedAt: nowIso,
          requestId: request.id,
          ...(generateId !== undefined ? { generateId } : {}),
        },
      );

      if (outcome.verification === 'failed') {
        throw googlePlayPurchaseRejectedError();
      }

      if (outcome.result === 'rejected') {
        throw mapProvisionRejection(outcome.reason);
      }

      if (outcome.result !== 'applied' && outcome.result !== 'replayed') {
        throw googlePlayPurchaseRejectedError();
      }

      if (outcome.acknowledgement === 'failed' || outcome.acknowledgement === undefined) {
        // Provision is durable; fail closed so the client can retry (replay + re-ack).
        throw googlePlayPurchaseAcknowledgeFailedError();
      }

      const entitlement = outcome.entitlement;
      if (!entitlement) {
        throw googlePlayPurchaseRejectedError();
      }

      const status = entitlement.status;
      if (
        status !== 'inactive' &&
        status !== 'active' &&
        status !== 'cancelling' &&
        status !== 'expired' &&
        status !== 'paid_pending_binding'
      ) {
        throw googlePlayPurchaseRejectedError();
      }

      return reply.status(200).send({
        data: {
          result: outcome.result,
          membership: {
            status,
            accessUntil: entitlement.accessUntil ? toIsoTimestamp(entitlement.accessUntil) : null,
            cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
          },
        },
      });
    },
  );

  done();
};
