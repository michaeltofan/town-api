import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import { STRIPE_API_VERSION, type StripeApiVersion } from '../config/env.js';

export { STRIPE_API_VERSION };
export type { StripeApiVersion };

/**
 * Bounded Stripe adapter surface. Only the calls required by the billing
 * runtime are exposed; the concrete implementations own all Stripe SDK details.
 */
export type TownStripeAdapter = {
  createCustomer: (
    params: Stripe.CustomerCreateParams,
    opts?: { idempotencyKey?: string },
  ) => Promise<Stripe.Customer>;
  createCheckoutSession: (
    params: Stripe.Checkout.SessionCreateParams,
    opts?: { idempotencyKey?: string },
  ) => Promise<Stripe.Checkout.Session>;
  createBillingPortalSession: (
    params: Stripe.BillingPortal.SessionCreateParams,
  ) => Promise<Stripe.BillingPortal.Session>;
  retrieveSubscription: (id: string) => Promise<Stripe.Subscription>;
  retrieveCheckoutSession: (id: string) => Promise<Stripe.Checkout.Session>;
  retrieveInvoice: (id: string) => Promise<Stripe.Invoice>;
  retrievePrice: (id: string) => Promise<Stripe.Price>;
  constructWebhookEvent: (
    rawBody: Buffer | string,
    signature: string,
    secret: string,
  ) => Stripe.Event;
};

/**
 * Production adapter. Wraps the official Stripe SDK with a fixed API version.
 */
export function createOfficialStripeAdapter(
  secretKey: string,
  apiVersion: StripeApiVersion = STRIPE_API_VERSION,
): TownStripeAdapter {
  const client = new Stripe(secretKey, {
    apiVersion,
    typescript: true,
  });
  return {
    createCustomer: async (params, opts) => {
      const requestOptions = opts?.idempotencyKey
        ? { idempotencyKey: opts.idempotencyKey }
        : undefined;
      return requestOptions
        ? client.customers.create(params, requestOptions)
        : client.customers.create(params);
    },
    createCheckoutSession: async (params, opts) => {
      const requestOptions = opts?.idempotencyKey
        ? { idempotencyKey: opts.idempotencyKey }
        : undefined;
      return requestOptions
        ? client.checkout.sessions.create(params, requestOptions)
        : client.checkout.sessions.create(params);
    },
    createBillingPortalSession: async (params) => client.billingPortal.sessions.create(params),
    retrieveSubscription: async (id) => client.subscriptions.retrieve(id),
    retrieveCheckoutSession: async (id) => client.checkout.sessions.retrieve(id),
    retrieveInvoice: async (id) => client.invoices.retrieve(id),
    retrievePrice: async (id) => client.prices.retrieve(id),
    constructWebhookEvent: (rawBody, signature, secret) =>
      client.webhooks.constructEvent(rawBody, signature, secret),
  };
}

/**
 * Deterministic in-memory Stripe adapter for tests. Uses the real Stripe SDK
 * static webhook helpers so signature verification remains authentic.
 */
export type FakeStripeState = {
  customers: Map<string, Stripe.Customer>;
  sessions: Map<string, Stripe.Checkout.Session>;
  portalSessions: Map<string, Stripe.BillingPortal.Session>;
  subscriptions: Map<string, Stripe.Subscription>;
  invoices: Map<string, Stripe.Invoice>;
  prices: Map<string, Stripe.Price>;
  idempotency: Map<string, string>;
  webhookSecret: string;
  now: () => Date;
  nextId: (kind: string) => string;
  errorHooks: {
    createCustomer?: () => Error | null;
    createCheckoutSession?: () => Error | null;
    createBillingPortalSession?: () => Error | null;
    retrieveSubscription?: (id: string) => Error | null;
    retrievePrice?: (id: string) => Error | null;
    retrieveInvoice?: (id: string) => Error | null;
    retrieveCheckoutSession?: (id: string) => Error | null;
  };
};

export function createFakeStripeState(input?: {
  webhookSecret?: string;
  now?: () => Date;
}): FakeStripeState {
  const state: FakeStripeState = {
    customers: new Map(),
    sessions: new Map(),
    portalSessions: new Map(),
    subscriptions: new Map(),
    invoices: new Map(),
    prices: new Map(),
    idempotency: new Map(),
    webhookSecret: input?.webhookSecret ?? 'whsec_town_fake_webhook_secret_placeholder',
    now: input?.now ?? (() => new Date()),
    errorHooks: {},
    nextId: (kind) => {
      const counter = String((counters.get(kind) ?? 0) + 1).padStart(12, '0');
      counters.set(kind, (counters.get(kind) ?? 0) + 1);
      return `${kind}_${counter}`;
    },
  };
  const counters = new Map<string, number>();
  return state;
}

function deriveObjectHash(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
}

function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function createFakeStripeAdapter(state: FakeStripeState): TownStripeAdapter {
  return {
    createCustomer(params, opts) {
      const hookError = state.errorHooks.createCustomer?.();
      if (hookError) {
        return Promise.reject(hookError);
      }
      if (opts?.idempotencyKey) {
        const existingId = state.idempotency.get(opts.idempotencyKey);
        if (existingId !== undefined) {
          const existing = state.customers.get(existingId);
          if (existing) {
            return Promise.resolve(existing);
          }
        }
      }
      const id = `cus_${deriveObjectHash({ params, opts })}`;
      const created: Stripe.Customer = {
        id,
        object: 'customer',
        created: toUnixSeconds(state.now()),
        default_source: null,
        description: null,
        email: params.email ?? null,
        invoice_prefix: null,
        invoice_settings: {
          custom_fields: null,
          default_payment_method: null,
          footer: null,
          rendering_options: null,
        },
        livemode: false,
        metadata: (params.metadata as Stripe.Metadata | undefined) ?? {},
        name: params.name ?? null,
        phone: params.phone ?? null,
        preferred_locales: params.preferred_locales ?? [],
        shipping: null,
        tax_exempt: 'none',
        test_clock: null,
      } as unknown as Stripe.Customer;
      state.customers.set(id, created);
      if (opts?.idempotencyKey) {
        state.idempotency.set(opts.idempotencyKey, id);
      }
      return Promise.resolve(created);
    },
    createCheckoutSession(params, opts) {
      const hookError = state.errorHooks.createCheckoutSession?.();
      if (hookError) {
        return Promise.reject(hookError);
      }
      if (opts?.idempotencyKey) {
        const existingId = state.idempotency.get(opts.idempotencyKey);
        if (existingId !== undefined) {
          const existing = state.sessions.get(existingId);
          if (existing) {
            return Promise.resolve(existing);
          }
        }
      }
      const id = `cs_${deriveObjectHash({ params, opts })}`;
      const session = {
        id,
        object: 'checkout.session',
        client_reference_id: params.client_reference_id ?? null,
        customer: typeof params.customer === 'string' ? params.customer : null,
        livemode: false,
        metadata: (params.metadata as Stripe.Metadata | undefined) ?? {},
        mode: params.mode ?? 'subscription',
        payment_status: 'unpaid',
        status: 'open',
        subscription: null,
        success_url: params.success_url ?? null,
        cancel_url: params.cancel_url ?? null,
        url: `https://checkout.stripe.com/pay/${id}`,
        created: toUnixSeconds(state.now()),
      } as unknown as Stripe.Checkout.Session;
      state.sessions.set(id, session);
      if (opts?.idempotencyKey) {
        state.idempotency.set(opts.idempotencyKey, id);
      }
      return Promise.resolve(session);
    },
    createBillingPortalSession(params) {
      const hookError = state.errorHooks.createBillingPortalSession?.();
      if (hookError) {
        return Promise.reject(hookError);
      }
      const id = `bps_${deriveObjectHash({ params })}`;
      const portal = {
        id,
        object: 'billing_portal.session',
        configuration: params.configuration ?? null,
        created: toUnixSeconds(state.now()),
        customer: params.customer,
        livemode: false,
        locale: null,
        on_behalf_of: null,
        return_url: params.return_url ?? null,
        url: `https://billing.stripe.com/session/${id}`,
      } as unknown as Stripe.BillingPortal.Session;
      state.portalSessions.set(id, portal);
      return Promise.resolve(portal);
    },
    retrieveSubscription(id) {
      const hookError = state.errorHooks.retrieveSubscription?.(id);
      if (hookError) {
        return Promise.reject(hookError);
      }
      const found = state.subscriptions.get(id);
      if (!found) {
        return Promise.reject(new Error(`Fake Stripe: subscription ${id} not found`));
      }
      return Promise.resolve(found);
    },
    retrieveCheckoutSession(id) {
      const hookError = state.errorHooks.retrieveCheckoutSession?.(id);
      if (hookError) {
        return Promise.reject(hookError);
      }
      const found = state.sessions.get(id);
      if (!found) {
        return Promise.reject(new Error(`Fake Stripe: checkout session ${id} not found`));
      }
      return Promise.resolve(found);
    },
    retrieveInvoice(id) {
      const hookError = state.errorHooks.retrieveInvoice?.(id);
      if (hookError) {
        return Promise.reject(hookError);
      }
      const found = state.invoices.get(id);
      if (!found) {
        return Promise.reject(new Error(`Fake Stripe: invoice ${id} not found`));
      }
      return Promise.resolve(found);
    },
    retrievePrice(id) {
      const hookError = state.errorHooks.retrievePrice?.(id);
      if (hookError) {
        return Promise.reject(hookError);
      }
      const found = state.prices.get(id);
      if (!found) {
        return Promise.reject(new Error(`Fake Stripe: price ${id} not found`));
      }
      return Promise.resolve(found);
    },
    constructWebhookEvent(rawBody, signature, secret) {
      // Uses the official Stripe verification path, so tests exercise the real signature contract.
      return Stripe.webhooks.constructEvent(rawBody, signature, secret);
    },
  };
}

/**
 * Sign a webhook JSON payload with the given secret using Stripe's official
 * helper. Returned string is used as the `Stripe-Signature` header value.
 */
export function signStripeWebhookHeader(input: {
  payload: string;
  secret: string;
  timestamp?: number;
}): string {
  return Stripe.webhooks.generateTestHeaderString({
    payload: input.payload,
    secret: input.secret,
    timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
  });
}
