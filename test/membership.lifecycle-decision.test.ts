import { describe, expect, it } from 'vitest';
import {
  decideMembershipAction,
  type AuthoritativeSubscriptionState,
  type MembershipLifecycleDecision,
  type MembershipLifecycleStatus,
} from '../src/membership/lifecycle/decide-membership-action.js';

const STORED_EXPIRY = 1_800_000_000_000;
const AUTHORITATIVE_EXPIRY = STORED_EXPIRY + 1_000;

type DecisionCase = [
  status: MembershipLifecycleStatus,
  authoritativeState: AuthoritativeSubscriptionState,
  expected: MembershipLifecycleDecision,
];

const cases: DecisionCase[] = [
  ['inactive', 'active', { kind: 'none' }],
  ['inactive', 'cancelled', { kind: 'none' }],
  ['inactive', 'on_hold', { kind: 'none' }],
  ['inactive', 'paused', { kind: 'none' }],
  ['inactive', 'expired', { kind: 'none' }],
  ['inactive', 'revoked', { kind: 'none' }],
  ['inactive', 'pending', { kind: 'none' }],

  ['active', 'active', { kind: 'extend', accessUntil: AUTHORITATIVE_EXPIRY }],
  ['active', 'cancelled', { kind: 'cancel_keep_access', accessUntil: AUTHORITATIVE_EXPIRY }],
  ['active', 'on_hold', { kind: 'suspend' }],
  ['active', 'paused', { kind: 'suspend' }],
  ['active', 'expired', { kind: 'expire' }],
  ['active', 'revoked', { kind: 'expire' }],
  ['active', 'pending', { kind: 'none' }],

  ['cancelling', 'active', { kind: 'none' }],
  ['cancelling', 'cancelled', { kind: 'cancel_keep_access', accessUntil: AUTHORITATIVE_EXPIRY }],
  ['cancelling', 'on_hold', { kind: 'suspend' }],
  ['cancelling', 'paused', { kind: 'suspend' }],
  ['cancelling', 'expired', { kind: 'expire' }],
  ['cancelling', 'revoked', { kind: 'expire' }],
  ['cancelling', 'pending', { kind: 'none' }],

  ['expired', 'active', { kind: 'none' }],
  ['expired', 'cancelled', { kind: 'none' }],
  ['expired', 'on_hold', { kind: 'none' }],
  ['expired', 'paused', { kind: 'none' }],
  ['expired', 'expired', { kind: 'none' }],
  ['expired', 'revoked', { kind: 'none' }],
  ['expired', 'pending', { kind: 'none' }],

  ['paid_pending_binding', 'active', { kind: 'none' }],
  ['paid_pending_binding', 'cancelled', { kind: 'none' }],
  ['paid_pending_binding', 'on_hold', { kind: 'none' }],
  ['paid_pending_binding', 'paused', { kind: 'none' }],
  ['paid_pending_binding', 'expired', { kind: 'none' }],
  ['paid_pending_binding', 'revoked', { kind: 'none' }],
  ['paid_pending_binding', 'pending', { kind: 'none' }],

  ['suspended', 'active', { kind: 'restore' }],
  ['suspended', 'cancelled', { kind: 'none' }],
  ['suspended', 'on_hold', { kind: 'none' }],
  ['suspended', 'paused', { kind: 'none' }],
  ['suspended', 'expired', { kind: 'expire' }],
  ['suspended', 'revoked', { kind: 'expire' }],
  ['suspended', 'pending', { kind: 'none' }],
];

describe('decideMembershipAction', () => {
  it.each(cases)('%s + authoritative %s', (status, authoritativeState, expected) => {
    expect(
      decideMembershipAction({
        status,
        accessUntil: STORED_EXPIRY,
        authoritative: {
          state: authoritativeState,
          expiry: AUTHORITATIVE_EXPIRY,
        },
      }),
    ).toEqual(expected);
  });

  it.each([
    ['equal', STORED_EXPIRY],
    ['earlier', STORED_EXPIRY - 1],
  ])(
    'does not extend active membership when authoritative expiry is %s',
    (_description, expiry) => {
      expect(
        decideMembershipAction({
          status: 'active',
          accessUntil: STORED_EXPIRY,
          authoritative: { state: 'active', expiry },
        }),
      ).toEqual({ kind: 'none' });
    },
  );

  it('compares Date values and returns the authoritative expiry unchanged', () => {
    const storedExpiry = new Date(STORED_EXPIRY);
    const authoritativeExpiry = new Date(AUTHORITATIVE_EXPIRY);

    expect(
      decideMembershipAction({
        status: 'active',
        accessUntil: storedExpiry,
        authoritative: { state: 'active', expiry: authoritativeExpiry },
      }),
    ).toEqual({ kind: 'extend', accessUntil: authoritativeExpiry });
  });
});
