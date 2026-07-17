import { describe, expect, it } from 'vitest';
import { hashStripeWebhookPayload } from '../src/billing/webhook-payload-hash.js';

describe('hashStripeWebhookPayload', () => {
  const baseline = {
    eventId: 'evt_1',
    eventType: 'invoice.paid',
    livemode: false,
    apiVersion: '2026-06-24.dahlia',
    customerId: 'cus_1',
    subscriptionId: 'sub_1',
    subscriptionStatus: 'active',
    invoiceId: 'in_1',
    checkoutSessionId: null,
    priceId: 'price_town_annual',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: 1_800_000_000,
    invoiceAmountPaid: 1200,
    invoiceCurrency: 'eur',
    invoiceStatus: 'paid',
    billingReference: 'ref-1',
  };

  it('is deterministic for the same input', () => {
    const a = hashStripeWebhookPayload(baseline);
    const b = hashStripeWebhookPayload({ ...baseline });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is insensitive to key insertion order', () => {
    const reordered = {
      livemode: baseline.livemode,
      apiVersion: baseline.apiVersion,
      billingReference: baseline.billingReference,
      eventId: baseline.eventId,
      eventType: baseline.eventType,
      customerId: baseline.customerId,
      subscriptionId: baseline.subscriptionId,
      subscriptionStatus: baseline.subscriptionStatus,
      invoiceId: baseline.invoiceId,
      checkoutSessionId: baseline.checkoutSessionId,
      priceId: baseline.priceId,
      cancelAtPeriodEnd: baseline.cancelAtPeriodEnd,
      currentPeriodEnd: baseline.currentPeriodEnd,
      invoiceAmountPaid: baseline.invoiceAmountPaid,
      invoiceCurrency: baseline.invoiceCurrency,
      invoiceStatus: baseline.invoiceStatus,
    };
    expect(hashStripeWebhookPayload(reordered)).toBe(hashStripeWebhookPayload(baseline));
  });

  it('changes when any authoritative field changes', () => {
    expect(hashStripeWebhookPayload({ ...baseline, invoiceAmountPaid: 1300 })).not.toBe(
      hashStripeWebhookPayload(baseline),
    );
    expect(hashStripeWebhookPayload({ ...baseline, cancelAtPeriodEnd: true })).not.toBe(
      hashStripeWebhookPayload(baseline),
    );
    expect(hashStripeWebhookPayload({ ...baseline, livemode: true })).not.toBe(
      hashStripeWebhookPayload(baseline),
    );
  });

  it('encodes null and non-null distinctly', () => {
    const withNull = hashStripeWebhookPayload({
      eventId: 'evt_1',
      eventType: 'invoice.paid',
      livemode: false,
      apiVersion: '2026-06-24.dahlia',
      customerId: null,
    });
    const withCustomer = hashStripeWebhookPayload({
      eventId: 'evt_1',
      eventType: 'invoice.paid',
      livemode: false,
      apiVersion: '2026-06-24.dahlia',
      customerId: 'cus_x',
    });
    expect(withNull).not.toBe(withCustomer);
  });
});
