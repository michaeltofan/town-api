import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import {
  assertAnnualPrice,
  TOWN_BILLING_CURRENCY,
  TOWN_BILLING_INTERVAL,
  TOWN_BILLING_INTERVAL_COUNT,
  TOWN_BILLING_QUANTITY,
  TOWN_BILLING_UNIT_AMOUNT,
} from '../src/billing/price-policy.js';

function buildPrice(overrides: Partial<Stripe.Price> = {}): Stripe.Price {
  return {
    id: 'price_town_annual',
    object: 'price',
    active: true,
    currency: 'eur',
    unit_amount: 1200,
    recurring: {
      interval: 'year',
      interval_count: 1,
    },
    ...overrides,
  } as unknown as Stripe.Price;
}

describe('assertAnnualPrice', () => {
  it('accepts the canonical annual price', () => {
    const result = assertAnnualPrice(buildPrice(), 'price_town_annual');
    expect(result).toEqual({ ok: true, priceId: 'price_town_annual' });
  });

  it('exposes the fixed constants', () => {
    expect(TOWN_BILLING_CURRENCY).toBe('eur');
    expect(TOWN_BILLING_UNIT_AMOUNT).toBe(1200);
    expect(TOWN_BILLING_INTERVAL).toBe('year');
    expect(TOWN_BILLING_INTERVAL_COUNT).toBe(1);
    expect(TOWN_BILLING_QUANTITY).toBe(1);
  });

  it('rejects unknown price id', () => {
    const result = assertAnnualPrice(buildPrice({ id: 'price_other' }), 'price_town_annual');
    expect(result).toEqual({ ok: false, reason: 'unknown_price_id' });
  });

  it('rejects inactive prices', () => {
    const result = assertAnnualPrice(buildPrice({ active: false }), 'price_town_annual');
    expect(result).toEqual({ ok: false, reason: 'inactive' });
  });

  it('rejects currency mismatch', () => {
    const result = assertAnnualPrice(buildPrice({ currency: 'usd' }), 'price_town_annual');
    expect(result).toEqual({ ok: false, reason: 'currency_mismatch' });
  });

  it('rejects unit amount mismatch', () => {
    const result = assertAnnualPrice(buildPrice({ unit_amount: 999 }), 'price_town_annual');
    expect(result).toEqual({ ok: false, reason: 'unit_amount_mismatch' });
  });

  it('rejects non-recurring prices', () => {
    const price = buildPrice({ recurring: null as unknown as Stripe.Price['recurring'] });
    const result = assertAnnualPrice(price, 'price_town_annual');
    expect(result).toEqual({ ok: false, reason: 'not_recurring' });
  });

  it('rejects wrong interval', () => {
    const price = buildPrice({
      recurring: { interval: 'month', interval_count: 1 } as unknown as Stripe.Price['recurring'],
    });
    const result = assertAnnualPrice(price, 'price_town_annual');
    expect(result).toEqual({ ok: false, reason: 'interval_mismatch' });
  });

  it('rejects wrong interval count', () => {
    const price = buildPrice({
      recurring: { interval: 'year', interval_count: 2 } as unknown as Stripe.Price['recurring'],
    });
    const result = assertAnnualPrice(price, 'price_town_annual');
    expect(result).toEqual({ ok: false, reason: 'interval_count_mismatch' });
  });
});
