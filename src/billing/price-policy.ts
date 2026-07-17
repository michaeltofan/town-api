import type Stripe from 'stripe';

export const TOWN_BILLING_CURRENCY = 'eur' as const;
export const TOWN_BILLING_UNIT_AMOUNT = 1200 as const;
export const TOWN_BILLING_INTERVAL = 'year' as const;
export const TOWN_BILLING_INTERVAL_COUNT = 1 as const;
export const TOWN_BILLING_QUANTITY = 1 as const;

export type PricePolicyMismatchReason =
  | 'unknown_price_id'
  | 'inactive'
  | 'currency_mismatch'
  | 'unit_amount_mismatch'
  | 'interval_mismatch'
  | 'interval_count_mismatch'
  | 'not_recurring';

export type PricePolicyResult =
  { ok: true; priceId: string } | { ok: false; reason: PricePolicyMismatchReason };

/**
 * Validates a Stripe price matches the fixed annual membership contract:
 *   currency=eur, unit_amount=1200, interval=year, interval_count=1, recurring, active.
 * Never mutates the price and never inspects tax/discount metadata.
 */
export function assertAnnualPrice(price: Stripe.Price, expectedPriceId: string): PricePolicyResult {
  if (price.id !== expectedPriceId) {
    return { ok: false, reason: 'unknown_price_id' };
  }
  if (!price.active) {
    return { ok: false, reason: 'inactive' };
  }
  if (price.currency !== TOWN_BILLING_CURRENCY) {
    return { ok: false, reason: 'currency_mismatch' };
  }
  if (price.unit_amount !== TOWN_BILLING_UNIT_AMOUNT) {
    return { ok: false, reason: 'unit_amount_mismatch' };
  }
  const recurring = price.recurring;
  if (!recurring) {
    return { ok: false, reason: 'not_recurring' };
  }
  if (recurring.interval !== TOWN_BILLING_INTERVAL) {
    return { ok: false, reason: 'interval_mismatch' };
  }
  if (recurring.interval_count !== TOWN_BILLING_INTERVAL_COUNT) {
    return { ok: false, reason: 'interval_count_mismatch' };
  }
  return { ok: true, priceId: price.id };
}
