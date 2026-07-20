import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import type Stripe from 'stripe';
import type { Env } from '../config/env.js';
import { requirePasskeyManagementConfig } from '../ceremony/passkey-management/config.js';
import { assertWebCookieCsrf } from '../ceremony/passkey-authentication/csrf.js';
import {
  parseSessionAuthorizationHeader,
  parseWebSessionCookie,
  type SessionTransportExtraction,
} from '../ceremony/passkey-authentication/session-transport.js';
import { resolveActiveSession } from '../ceremony/passkey-authentication/service.js';
import { findVerifiedPrimaryEmailForAccount } from '../identity/repositories/emails.js';
import {
  AppError,
  billingCheckoutFailedError,
  billingCustomerNotAvailableError,
  billingManageExistingSubscriptionError,
  billingNotAvailableError,
  billingPortalFailedError,
  membershipAlreadyActiveError,
} from '../errors/app-error.js';
import { ERROR_CODE } from '../schemas/error.js';
import {
  isBillingCheckoutThrottled,
  isBillingPortalThrottled,
  recordBillingCheckoutAttempt,
  recordBillingPortalAttempt,
} from '../billing/rate-limits.js';
import {
  createCheckoutSessionForAccount,
  CheckoutServiceRejection,
  type CheckoutConfig,
} from '../billing/checkout-service.js';
import {
  createBillingPortalSessionForAccount,
  PortalServiceRejection,
  type PortalConfig,
} from '../billing/portal-service.js';
import { processStripeWebhookEvent } from '../billing/webhook-processor.js';
import { BillingRouteResponses, EmptyBodySchema } from '../billing/schemas.js';
import type { TownStripeAdapter } from '../billing/stripe-adapter.js';
import { createOfficialStripeAdapter } from '../billing/stripe-adapter.js';

export type BillingRoutesOptions = {
  env: Env;
  now?: () => string;
  generateId?: () => string;
  stripeAdapter?: TownStripeAdapter;
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

function mapCheckoutRejection(rejection: CheckoutServiceRejection): AppError {
  switch (rejection.rejection.code) {
    case 'MEMBERSHIP_ALREADY_ACTIVE':
      return membershipAlreadyActiveError();
    case 'BILLING_MANAGE_EXISTING_SUBSCRIPTION':
      return billingManageExistingSubscriptionError();
    case 'BILLING_NOT_AVAILABLE':
      return billingNotAvailableError();
    case 'BILLING_CHECKOUT_FAILED':
    default:
      return billingCheckoutFailedError();
  }
}

function mapPortalRejection(rejection: PortalServiceRejection): AppError {
  switch (rejection.rejection.code) {
    case 'BILLING_CUSTOMER_NOT_AVAILABLE':
      return billingCustomerNotAvailableError();
    case 'BILLING_PORTAL_FAILED':
    default:
      return billingPortalFailedError();
  }
}

export const billingRoutes: FastifyPluginCallbackTypebox<BillingRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { env } = options;
  const nowFn = () => (options.now ?? (() => new Date().toISOString()))();
  const generateId = options.generateId;

  const resolveAdapter = (): TownStripeAdapter | null => {
    if (options.stripeAdapter) {
      return options.stripeAdapter;
    }
    if (!env.STRIPE_BILLING_ENABLED || !env.STRIPE_SECRET_KEY) {
      return null;
    }
    return createOfficialStripeAdapter(env.STRIPE_SECRET_KEY, env.STRIPE_API_VERSION);
  };

  type BillingConfigResolved = {
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    portalConfigurationId: string;
    portalReturnUrl: string;
    webhookSecret: string;
    expectedLivemode: boolean;
  };

  const resolveBillingConfig = (): BillingConfigResolved | null => {
    const priceId = env.STRIPE_ANNUAL_PRICE_ID;
    const successUrl = env.STRIPE_CHECKOUT_SUCCESS_URL;
    const cancelUrl = env.STRIPE_CHECKOUT_CANCEL_URL;
    const portalConfigurationId = env.STRIPE_PORTAL_CONFIGURATION_ID;
    const portalReturnUrl = env.STRIPE_PORTAL_RETURN_URL;
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    if (
      !priceId ||
      !successUrl ||
      !cancelUrl ||
      !portalConfigurationId ||
      !portalReturnUrl ||
      !webhookSecret
    ) {
      return null;
    }
    return {
      priceId,
      successUrl,
      cancelUrl,
      portalConfigurationId,
      portalReturnUrl,
      webhookSecret,
      expectedLivemode: env.STRIPE_EXPECTED_LIVEMODE ?? false,
    };
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
    '/v1/billing/checkout-session',
    {
      schema: {
        tags: ['Billing'],
        summary: 'Create a Stripe Checkout Session for the authenticated account',
        description:
          'Creates or reuses the Stripe Customer for the caller account and starts a Stripe Checkout Session for the annual TOWN membership price. Requires an active web or mobile session. SetupGrant, RecoveryGrant, and Bearer are rejected. Never exposes Stripe customer or subscription identifiers. Only returns the Stripe-issued Checkout URL.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        body: EmptyBodySchema,
        response: BillingRouteResponses.checkoutSession,
      },
    },
    async (request, reply) => {
      if (!env.STRIPE_BILLING_ENABLED) {
        reply.callNotFound();
        return;
      }
      const adapter = resolveAdapter();
      const billing = resolveBillingConfig();
      if (!adapter || !billing) {
        throw billingNotAvailableError();
      }
      const { accountId } = await requireSession({
        headers: request.headers,
        cookies: request.cookies,
      });

      const config = requirePasskeyManagementConfig(env);
      const nowIso = nowFn();
      const throttled = await isBillingCheckoutThrottled(app.database.db, {
        rateLimitHashKey: config.rateLimitHashKey,
        accountId,
        now: nowIso,
      });
      await recordBillingCheckoutAttempt(app.database.db, {
        rateLimitHashKey: config.rateLimitHashKey,
        accountId,
        now: nowIso,
        throttled,
        requestId: request.id,
      });
      if (throttled) {
        throw rateLimitedError();
      }

      const primaryEmailRow = await findVerifiedPrimaryEmailForAccount(app.database.db, accountId);
      const primaryEmail = primaryEmailRow?.emailOriginal ?? null;

      const checkoutConfig: CheckoutConfig = {
        priceId: billing.priceId,
        successUrl: billing.successUrl,
        cancelUrl: billing.cancelUrl,
        expectedLivemode: billing.expectedLivemode,
      };

      try {
        const result = await createCheckoutSessionForAccount(
          app.database.db,
          adapter,
          checkoutConfig,
          {
            accountId,
            accountEmail: primaryEmail,
            now: nowIso,
            ...(generateId ? { generateId } : {}),
            requestId: request.id,
          },
        );
        return await reply.status(200).send({ data: { checkoutUrl: result.checkoutUrl } });
      } catch (error) {
        if (error instanceof CheckoutServiceRejection) {
          throw mapCheckoutRejection(error);
        }
        throw error;
      }
    },
  );

  app.post(
    '/v1/billing/customer-portal-session',
    {
      schema: {
        tags: ['Billing'],
        summary: 'Create a Stripe Customer Portal Session for the authenticated account',
        description:
          'Starts a Stripe Billing Portal Session for the caller account when a Stripe customer link exists. Requires an active web or mobile session. SetupGrant, RecoveryGrant, and Bearer are rejected. Only returns the Stripe-issued portal URL. Never mutates membership entitlement rows.',
        security: [{ sessionAuth: [] }, { mobileSessionAuth: [] }],
        body: EmptyBodySchema,
        response: BillingRouteResponses.portalSession,
      },
    },
    async (request, reply) => {
      if (!env.STRIPE_BILLING_ENABLED) {
        reply.callNotFound();
        return;
      }
      const adapter = resolveAdapter();
      const billing = resolveBillingConfig();
      if (!adapter || !billing) {
        throw billingNotAvailableError();
      }
      const { accountId } = await requireSession({
        headers: request.headers,
        cookies: request.cookies,
      });

      const config = requirePasskeyManagementConfig(env);
      const nowIso = nowFn();
      const throttled = await isBillingPortalThrottled(app.database.db, {
        rateLimitHashKey: config.rateLimitHashKey,
        accountId,
        now: nowIso,
      });
      await recordBillingPortalAttempt(app.database.db, {
        rateLimitHashKey: config.rateLimitHashKey,
        accountId,
        now: nowIso,
        throttled,
        requestId: request.id,
      });
      if (throttled) {
        throw rateLimitedError();
      }

      const portalConfig: PortalConfig = {
        configurationId: billing.portalConfigurationId,
        returnUrl: billing.portalReturnUrl,
      };

      try {
        const result = await createBillingPortalSessionForAccount(
          app.database.db,
          adapter,
          portalConfig,
          {
            accountId,
            now: nowIso,
            ...(generateId ? { generateId } : {}),
            requestId: request.id,
          },
        );
        return await reply.status(200).send({ data: { portalUrl: result.portalUrl } });
      } catch (error) {
        if (error instanceof PortalServiceRejection) {
          throw mapPortalRejection(error);
        }
        throw error;
      }
    },
  );

  // Webhook route in an encapsulated plugin with raw-body Buffer parser.
  void app.register((scope, _opts, pluginDone) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      const raw = body as Buffer;
      (req as FastifyRequest & { rawBody?: Buffer }).rawBody = raw;
      // Signature verification uses rawBody. If the JSON is malformed, defer
      // the 400 to signature verification (which will reject the modified body).
      try {
        done(null, raw.length ? (JSON.parse(raw.toString('utf8')) as unknown) : {});
      } catch {
        done(null, {});
      }
    });

    scope.post(
      '/v1/billing/stripe/webhook',
      {
        bodyLimit: 1_048_576,
        schema: {
          tags: ['Billing'],
          summary: 'Receive a Stripe webhook event for TOWN billing',
          description:
            'Signature-verified Stripe webhook. Requires a raw JSON body and a valid Stripe-Signature header. Feature-gated by STRIPE_BILLING_ENABLED. Returns { received: true } for all applied/replayed/ignored outcomes. Rejects mismatched signatures with 400 without hitting the processor.',
          response: BillingRouteResponses.webhook,
        },
      },
      async (request, reply) => {
        if (!env.STRIPE_BILLING_ENABLED) {
          reply.callNotFound();
          return;
        }
        const adapter = resolveAdapter();
        const billing = resolveBillingConfig();
        if (!adapter || !billing) {
          throw billingNotAvailableError();
        }
        const signature = singleHeader(request.headers['stripe-signature']);
        if (typeof signature !== 'string' || signature.length === 0) {
          // Domain envelope must match BillingRouteResponses.webhook[400]
          // (DomainErrorResponseSchema). Flat bodies fail response serialization → 500.
          throw new AppError(400, ERROR_CODE.BAD_REQUEST, 'Missing Stripe-Signature header.');
        }
        const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
        if (!rawBody) {
          throw new AppError(
            400,
            ERROR_CODE.BAD_REQUEST,
            'Missing request body for webhook verification.',
          );
        }
        let event: Stripe.Event;
        try {
          event = adapter.constructWebhookEvent(rawBody, signature, billing.webhookSecret);
        } catch {
          throw new AppError(400, ERROR_CODE.BAD_REQUEST, 'Stripe signature verification failed.');
        }

        await processStripeWebhookEvent(
          {
            db: app.database.db,
            adapter,
            config: {
              priceId: billing.priceId,
              expectedLivemode: billing.expectedLivemode,
              nodeEnv: env.NODE_ENV,
            },
            now: nowFn,
            ...(generateId ? { generateId } : {}),
            requestId: request.id,
          },
          event,
        );

        return await reply.status(200).send({ received: true });
      },
    );
    pluginDone();
  });

  done();
};
