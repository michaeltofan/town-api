export type MembershipLifecycleTimestamp = Date | number;

export type MembershipLifecycleStatus =
  'inactive' | 'active' | 'cancelling' | 'expired' | 'paid_pending_binding' | 'suspended';

export type AuthoritativeSubscriptionState =
  'active' | 'cancelled' | 'on_hold' | 'paused' | 'expired' | 'revoked' | 'pending';

export type AuthoritativeSubscriptionFacts = {
  state: AuthoritativeSubscriptionState;
  expiry: MembershipLifecycleTimestamp;
};

export type MembershipLifecycleDecision =
  | { kind: 'none' }
  | { kind: 'extend'; accessUntil: MembershipLifecycleTimestamp }
  | { kind: 'cancel_keep_access'; accessUntil: MembershipLifecycleTimestamp }
  | { kind: 'suspend' }
  | { kind: 'restore' }
  | { kind: 'expire' };

export type MembershipLifecycleDecisionInput = {
  status: MembershipLifecycleStatus;
  accessUntil: MembershipLifecycleTimestamp;
  authoritative: AuthoritativeSubscriptionFacts;
};

function toEpochMilliseconds(value: MembershipLifecycleTimestamp): number {
  return value instanceof Date ? value.getTime() : value;
}

export function decideMembershipAction(
  input: MembershipLifecycleDecisionInput,
): MembershipLifecycleDecision {
  const { status, authoritative } = input;

  if (status === 'active') {
    switch (authoritative.state) {
      case 'active':
        return toEpochMilliseconds(authoritative.expiry) > toEpochMilliseconds(input.accessUntil)
          ? { kind: 'extend', accessUntil: authoritative.expiry }
          : { kind: 'none' };
      case 'cancelled':
        return { kind: 'cancel_keep_access', accessUntil: authoritative.expiry };
      case 'on_hold':
      case 'paused':
        return { kind: 'suspend' };
      case 'expired':
      case 'revoked':
        return { kind: 'expire' };
      default:
        return { kind: 'none' };
    }
  }

  if (status === 'cancelling') {
    switch (authoritative.state) {
      case 'cancelled':
        return { kind: 'cancel_keep_access', accessUntil: authoritative.expiry };
      case 'on_hold':
      case 'paused':
        return { kind: 'suspend' };
      case 'expired':
      case 'revoked':
        return { kind: 'expire' };
      default:
        return { kind: 'none' };
    }
  }

  if (status === 'suspended') {
    switch (authoritative.state) {
      case 'active':
        return { kind: 'restore' };
      case 'expired':
      case 'revoked':
        return { kind: 'expire' };
      default:
        return { kind: 'none' };
    }
  }

  return { kind: 'none' };
}
