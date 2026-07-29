import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { Pool } from 'pg';
import { buildApp, type AppInstance } from '../../src/app.js';
import { createInMemoryTestDeliveryAdapter } from '../../src/ceremony/email-verification/delivery.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { createDatabase } from '../../src/db/client.js';
import {
  createFakeStripeAdapter,
  createFakeStripeState,
  signStripeWebhookHeader,
  type FakeStripeState,
  type TownStripeAdapter,
} from '../../src/billing/stripe-adapter.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './pg.js';
import {
  TEST_CEREMONY_RATE_LIMIT_HASH_KEY,
  TEST_EMAIL_VERIFICATION_HASH_KEY,
  TEST_ORIGIN,
  TEST_RP_ID,
  TEST_WEBAUTHN_CHALLENGE_HASH_KEY,
} from './passkey-registration.js';
import {
  TEST_PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY,
  TEST_SESSION_TOKEN_HASH_KEY,
  TEST_WEB_SESSION_COOKIE_NAME,
} from './passkey-authentication.js';

export const TEST_STRIPE_SECRET_KEY = 'sk_test_town_fake_stripe_secret_placeholder';
export const TEST_STRIPE_WEBHOOK_SECRET = 'whsec_town_fake_stripe_webhook_secret_placeholder';
export const TEST_STRIPE_ANNUAL_PRICE_ID = 'price_town_test_annual_placeholder';
export const TEST_STRIPE_PORTAL_CONFIGURATION_ID = 'bpc_town_test_portal_placeholder';
export const TEST_STRIPE_CHECKOUT_SUCCESS_URL = 'https://example.test/checkout/success';
export const TEST_STRIPE_CHECKOUT_CANCEL_URL = 'https://example.test/checkout/cancel';
export const TEST_STRIPE_PORTAL_RETURN_URL = 'https://example.test/portal/return';

export function createBillingEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    LOG_LEVEL: 'silent',
    DATABASE_URL: requireDatabaseUrl(),
    DB_POOL_MAX: '5',
    DB_CONNECTION_TIMEOUT_MS: '3000',
    DB_IDLE_TIMEOUT_MS: '1000',
    CONTROLLED_CONFIRMATION_ENABLED: 'false',
    EMAIL_VERIFICATION_ENABLED: 'true',
    EMAIL_VERIFICATION_HASH_KEY: TEST_EMAIL_VERIFICATION_HASH_KEY,
    CEREMONY_RATE_LIMIT_HASH_KEY: TEST_CEREMONY_RATE_LIMIT_HASH_KEY,
    EMAIL_VERIFICATION_DELIVERY_MODE: 'test',
    PASSWORD_AUTH_ENABLED: 'true',
    WEBAUTHN_REGISTRATION_ENABLED: 'true',
    WEBAUTHN_RP_ID: TEST_RP_ID,
    WEBAUTHN_RP_NAME: 'TOWN',
    WEBAUTHN_ALLOWED_ORIGINS: TEST_ORIGIN,
    WEBAUTHN_CHALLENGE_HASH_KEY: TEST_WEBAUTHN_CHALLENGE_HASH_KEY,
    PASSKEY_AUTHENTICATION_ENABLED: 'true',
    PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY: TEST_PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY,
    SESSION_TOKEN_HASH_KEY: TEST_SESSION_TOKEN_HASH_KEY,
    WEB_SESSION_COOKIE_NAME: TEST_WEB_SESSION_COOKIE_NAME,
    STRIPE_BILLING_ENABLED: 'true',
    STRIPE_SECRET_KEY: TEST_STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: TEST_STRIPE_WEBHOOK_SECRET,
    STRIPE_ANNUAL_PRICE_ID: TEST_STRIPE_ANNUAL_PRICE_ID,
    STRIPE_PORTAL_CONFIGURATION_ID: TEST_STRIPE_PORTAL_CONFIGURATION_ID,
    STRIPE_CHECKOUT_SUCCESS_URL: TEST_STRIPE_CHECKOUT_SUCCESS_URL,
    STRIPE_CHECKOUT_CANCEL_URL: TEST_STRIPE_CHECKOUT_CANCEL_URL,
    STRIPE_PORTAL_RETURN_URL: TEST_STRIPE_PORTAL_RETURN_URL,
    STRIPE_API_VERSION: '2026-06-24.dahlia',
    STRIPE_EXPECTED_LIVEMODE: 'false',
    TRUST_PROXY: 'false',
    ...overrides,
  });
}

export type BillingTestApp = {
  app: AppInstance;
  pool: Pool;
  env: Env;
  delivery: ReturnType<typeof createInMemoryTestDeliveryAdapter>;
  stripeState: FakeStripeState;
  stripeAdapter: TownStripeAdapter;
};

export type CreateBillingTestAppOptions = {
  billingEnabled?: boolean;
  now?: () => string;
  generateId?: () => string;
  generateToken?: () => string;
  webhookSecret?: string;
};

export async function createBillingTestApp(
  options: CreateBillingTestAppOptions = {},
): Promise<BillingTestApp> {
  const databaseUrl = requireDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  await resetMigrateSeedFoundationAndActor(pool);

  const billingEnabled = options.billingEnabled ?? true;
  const env = createBillingEnv(billingEnabled ? {} : { STRIPE_BILLING_ENABLED: 'false' });
  const delivery = createInMemoryTestDeliveryAdapter();
  const stripeState = createFakeStripeState({
    webhookSecret: options.webhookSecret ?? env.STRIPE_WEBHOOK_SECRET ?? TEST_STRIPE_WEBHOOK_SECRET,
  });
  const stripeAdapter = createFakeStripeAdapter(stripeState);
  primeAnnualPrice(stripeState, env.STRIPE_ANNUAL_PRICE_ID ?? TEST_STRIPE_ANNUAL_PRICE_ID);

  const database = createDatabase({
    connectionString: env.DATABASE_URL,
    poolMax: env.DB_POOL_MAX,
    connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
  });

  const app = await buildApp({
    env,
    logger: false,
    database,
    stripeAdapter,
    emailVerification: {
      deliveryAdapter: delivery,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
    passwordSetup: {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
    passkeyRegistration: {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
      ...(options.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
    },
    passkeyAuthentication: {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
      ...(options.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
    },
    passkeyManagement: {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
      ...(options.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
    },
    billing: {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
  });
  await app.ready();

  return { app, pool, env, delivery, stripeState, stripeAdapter };
}

/**
 * Seed the fake Stripe state with a valid annual price matching TOWN's price policy.
 */
export function primeAnnualPrice(
  state: FakeStripeState,
  priceId: string,
  overrides?: Partial<Stripe.Price>,
): Stripe.Price {
  const price = {
    id: priceId,
    object: 'price',
    active: true,
    billing_scheme: 'per_unit',
    created: Math.floor(state.now().getTime() / 1000),
    currency: 'eur',
    livemode: false,
    lookup_key: null,
    metadata: {},
    nickname: null,
    product: 'prod_town_annual_membership',
    recurring: {
      aggregate_usage: null,
      interval: 'year',
      interval_count: 1,
      trial_period_days: null,
      usage_type: 'licensed',
    },
    tax_behavior: 'unspecified',
    tiers_mode: null,
    transform_quantity: null,
    type: 'recurring',
    unit_amount: 1200,
    unit_amount_decimal: '1200',
    ...overrides,
  } as unknown as Stripe.Price;
  state.prices.set(priceId, price);
  return price;
}

export function primeSubscription(
  state: FakeStripeState,
  input: {
    id?: string;
    customerId: string;
    priceId: string;
    currentPeriodEnd: number;
    status?: Stripe.Subscription.Status;
    cancelAtPeriodEnd?: boolean;
  },
): Stripe.Subscription {
  const id = input.id ?? `sub_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const now = Math.floor(state.now().getTime() / 1000);
  const subscription = {
    id,
    object: 'subscription',
    customer: input.customerId,
    status: input.status ?? 'active',
    livemode: false,
    metadata: {},
    cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
    current_period_end: input.currentPeriodEnd,
    current_period_start: now,
    start_date: now,
    trial_end: null,
    trial_start: null,
    pause_collection: null,
    items: {
      object: 'list',
      data: [
        {
          id: `si_${id}_item`,
          object: 'subscription_item',
          quantity: 1,
          current_period_end: input.currentPeriodEnd,
          price: state.prices.get(input.priceId) ?? {
            id: input.priceId,
            object: 'price',
            active: true,
            currency: 'eur',
            unit_amount: 1200,
            recurring: { interval: 'year', interval_count: 1 },
          },
        },
      ],
      has_more: false,
      url: `/v1/subscriptions/${id}/items`,
    },
  } as unknown as Stripe.Subscription;
  state.subscriptions.set(id, subscription);
  return subscription;
}

export function primeInvoice(
  state: FakeStripeState,
  input: {
    id?: string;
    customerId: string;
    subscriptionId: string;
    amountPaid?: number;
    status?: Stripe.Invoice.Status;
  },
): Stripe.Invoice {
  const id = input.id ?? `in_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const invoice = {
    id,
    object: 'invoice',
    customer: input.customerId,
    subscription: input.subscriptionId,
    parent: {
      type: 'subscription_details',
      subscription_details: { subscription: input.subscriptionId },
    },
    amount_paid: input.amountPaid ?? 1200,
    currency: 'eur',
    status: input.status ?? 'paid',
    livemode: false,
    metadata: {},
    lines: {
      object: 'list',
      data: [],
      has_more: false,
      url: `/v1/invoices/${id}/lines`,
    },
  } as unknown as Stripe.Invoice;
  state.invoices.set(id, invoice);
  return invoice;
}

export type BuildSignedWebhookRequest = {
  event: Stripe.Event;
  signature: string;
  rawBody: string;
};

export function buildSignedWebhookRequest(input: {
  eventType: Stripe.Event['type'];
  data: Record<string, unknown>;
  secret?: string;
  eventId?: string;
  apiVersion?: string;
  livemode?: boolean;
  timestamp?: number;
  request?: Stripe.Event.Request | null;
}): BuildSignedWebhookRequest {
  const secret = input.secret ?? TEST_STRIPE_WEBHOOK_SECRET;
  const eventId = input.eventId ?? `evt_${randomUUID().replace(/-/g, '')}`;
  const created = input.timestamp ?? Math.floor(Date.now() / 1000);
  const event: Stripe.Event = {
    id: eventId,
    object: 'event',
    api_version: input.apiVersion ?? '2026-06-24.dahlia',
    created,
    data: { object: input.data as unknown as Stripe.Event.Data.Object },
    livemode: input.livemode ?? false,
    pending_webhooks: 0,
    request: input.request ?? null,
    type: input.eventType,
  } as unknown as Stripe.Event;
  const rawBody = JSON.stringify(event);
  const signature = signStripeWebhookHeader({
    payload: rawBody,
    secret,
    timestamp: created,
  });
  return { event, signature, rawBody };
}

export { signStripeWebhookHeader };
