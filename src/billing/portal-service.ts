import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import { appendIdentitySecurityEvent } from '../identity/repositories/security-events.js';
import { findCustomerLinkByAccountId } from './repositories/customer-links.js';
import type { TownStripeAdapter } from './stripe-adapter.js';

type Db = Database['db'];

export type PortalServiceError =
  { code: 'BILLING_CUSTOMER_NOT_AVAILABLE' } | { code: 'BILLING_PORTAL_FAILED'; reason: string };

export class PortalServiceRejection extends Error {
  readonly rejection: PortalServiceError;
  constructor(rejection: PortalServiceError) {
    super(rejection.code);
    this.name = 'PortalServiceRejection';
    this.rejection = rejection;
  }
}

export type PortalConfig = {
  configurationId: string;
  returnUrl: string;
};

export type CreatePortalSessionInput = {
  accountId: string;
  now: string;
  generateId?: () => string;
  requestId?: string | null;
};

export type CreatePortalSessionResult = {
  portalUrl: string;
};

export async function createBillingPortalSessionForAccount(
  db: Db,
  adapter: TownStripeAdapter,
  config: PortalConfig,
  input: CreatePortalSessionInput,
): Promise<CreatePortalSessionResult> {
  const generateId = input.generateId ?? randomUUID;

  const link = await findCustomerLinkByAccountId(db, input.accountId);
  if (!link) {
    throw new PortalServiceRejection({ code: 'BILLING_CUSTOMER_NOT_AVAILABLE' });
  }

  let session;
  try {
    session = await adapter.createBillingPortalSession({
      customer: link.stripeCustomerId,
      configuration: config.configurationId,
      return_url: config.returnUrl,
    });
  } catch (error) {
    throw new PortalServiceRejection({
      code: 'BILLING_PORTAL_FAILED',
      reason: error instanceof Error ? 'stripe_error' : 'unknown',
    });
  }
  if (!session.url) {
    throw new PortalServiceRejection({
      code: 'BILLING_PORTAL_FAILED',
      reason: 'missing_session_url',
    });
  }

  await appendIdentitySecurityEvent(db, {
    id: generateId(),
    accountId: input.accountId,
    eventType: 'stripe_customer_linked',
    occurredAt: input.now,
    requestId: input.requestId ?? null,
    metadata: {
      purpose: 'billing_portal_session',
    },
  });

  return { portalUrl: session.url };
}
