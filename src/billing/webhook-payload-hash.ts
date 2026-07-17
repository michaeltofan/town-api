import { createHash } from 'node:crypto';

/**
 * Canonical Stripe webhook event fields hashed by webhook-processor for
 * idempotency-with-payload-hash checks. Never store the raw event body, raw
 * signature, email, address, or card details.
 */
export type StripeWebhookHashableFields = {
  eventId: string;
  eventType: string;
  livemode: boolean;
  apiVersion: string | null;
  customerId?: string | null;
  subscriptionId?: string | null;
  subscriptionStatus?: string | null;
  invoiceId?: string | null;
  checkoutSessionId?: string | null;
  priceId?: string | null;
  cancelAtPeriodEnd?: boolean | null;
  currentPeriodEnd?: number | null;
  invoiceAmountPaid?: number | null;
  invoiceCurrency?: string | null;
  invoiceStatus?: string | null;
  billingReference?: string | null;
};

const KEY_ORDER: readonly (keyof StripeWebhookHashableFields)[] = [
  'apiVersion',
  'billingReference',
  'cancelAtPeriodEnd',
  'checkoutSessionId',
  'currentPeriodEnd',
  'customerId',
  'eventId',
  'eventType',
  'invoiceAmountPaid',
  'invoiceCurrency',
  'invoiceId',
  'invoiceStatus',
  'livemode',
  'priceId',
  'subscriptionId',
  'subscriptionStatus',
] as const;

export function hashStripeWebhookPayload(fields: StripeWebhookHashableFields): string {
  const canonical: Record<string, string | number | boolean | null> = {};
  for (const key of KEY_ORDER) {
    const value = fields[key];
    if (value !== undefined) {
      canonical[key] = value;
    }
  }
  const json = JSON.stringify(canonical);
  return createHash('sha256').update(json).digest('hex');
}
