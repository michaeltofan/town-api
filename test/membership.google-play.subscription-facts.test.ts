import { describe, expect, it } from 'vitest';
import { mapSubscriptionPurchaseToNeutralFacts } from '../src/membership/lifecycle/map-subscription-purchase-to-facts.js';

const EXPIRY_TIME = '2026-08-01T12:34:56.789Z';
const EXPIRY = Date.parse(EXPIRY_TIME);

const documentedStates = [
  ['SUBSCRIPTION_STATE_PENDING', 'pending'],
  ['SUBSCRIPTION_STATE_ACTIVE', 'active'],
  ['SUBSCRIPTION_STATE_PAUSED', 'paused'],
  ['SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'active'],
  ['SUBSCRIPTION_STATE_ON_HOLD', 'on_hold'],
  ['SUBSCRIPTION_STATE_CANCELED', 'cancelled'],
  ['SUBSCRIPTION_STATE_EXPIRED', 'expired'],
  ['SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED', 'expired'],
] as const;

function subscription(subscriptionState: string, expiryTime = EXPIRY_TIME): unknown {
  return {
    subscriptionState,
    lineItems: [{ expiryTime }],
  };
}

describe('mapSubscriptionPurchaseToNeutralFacts', () => {
  it.each(documentedStates)('maps documented %s to %s', (subscriptionState, state) => {
    expect(mapSubscriptionPurchaseToNeutralFacts(subscription(subscriptionState))).toEqual({
      ok: true,
      facts: { state, expiry: EXPIRY },
    });
  });

  it('maps the authoritative RFC3339 expiry instant without changing it', () => {
    const expiryTime = '2027-03-04T05:06:07.123+05:30';

    expect(
      mapSubscriptionPurchaseToNeutralFacts(subscription('SUBSCRIPTION_STATE_ACTIVE', expiryTime)),
    ).toEqual({
      ok: true,
      facts: {
        state: 'active',
        expiry: Date.parse(expiryTime),
      },
    });
  });

  it('uses the latest valid line-item expiry', () => {
    expect(
      mapSubscriptionPurchaseToNeutralFacts({
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
        lineItems: [{ expiryTime: '2026-08-01T12:34:56Z' }, { expiryTime: '2026-09-01T12:34:56Z' }],
      }),
    ).toEqual({
      ok: true,
      facts: {
        state: 'active',
        expiry: Date.parse('2026-09-01T12:34:56Z'),
      },
    });
  });

  it.each([
    [
      'unspecified state',
      subscription('SUBSCRIPTION_STATE_UNSPECIFIED'),
      'subscription_state_unsupported',
    ],
    [
      'unknown future state',
      subscription('SUBSCRIPTION_STATE_FUTURE'),
      'subscription_state_unsupported',
    ],
    ['non-object input', null, 'subscription_purchase_v2_not_object'],
    ['missing state', { lineItems: [{ expiryTime: EXPIRY_TIME }] }, 'subscription_state_missing'],
    [
      'missing expiry',
      { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', lineItems: [{}] },
      'subscription_expiry_time_missing',
    ],
    [
      'unparseable expiry',
      subscription('SUBSCRIPTION_STATE_ACTIVE', 'not-a-timestamp'),
      'subscription_expiry_time_invalid',
    ],
    [
      'impossible calendar date',
      subscription('SUBSCRIPTION_STATE_ACTIVE', '2026-02-30T12:00:00Z'),
      'subscription_expiry_time_invalid',
    ],
  ])('fails closed for %s', (_description, input, reason) => {
    const result = mapSubscriptionPurchaseToNeutralFacts(input);

    expect(result).toEqual({ ok: false, reason });
    expect('facts' in result).toBe(false);
  });

  it('never emits revoked for any documented state', () => {
    for (const [subscriptionState] of documentedStates) {
      const result = mapSubscriptionPurchaseToNeutralFacts(subscription(subscriptionState));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.facts.state).not.toBe('revoked');
      }
    }
  });

  it('does not infer revocation from EXPIRED', () => {
    expect(
      mapSubscriptionPurchaseToNeutralFacts(subscription('SUBSCRIPTION_STATE_EXPIRED')),
    ).toEqual({
      ok: true,
      facts: { state: 'expired', expiry: EXPIRY },
    });
  });
});
