import type { AuthoritativeSubscriptionFacts } from './decide-membership-action.js';
import { GOOGLE_PLAY_SUBSCRIPTION_STATE_ACTIVE } from '../google-play/subscription-purchase-v2.js';

type SubscriptionPurchaseV2Input = {
  subscriptionState?: unknown;
  lineItems?: unknown;
};

type SubscriptionPurchaseLineItemInput = {
  expiryTime?: unknown;
};

type MappingFailureReason =
  | 'subscription_purchase_v2_not_object'
  | 'subscription_state_missing'
  | 'subscription_state_unsupported'
  | 'subscription_line_items_missing'
  | 'subscription_line_item_invalid'
  | 'subscription_expiry_time_missing'
  | 'subscription_expiry_time_invalid';

type SubscriptionPurchaseFactsResult =
  { ok: true; facts: AuthoritativeSubscriptionFacts } | { ok: false; reason: MappingFailureReason };

const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRfc3339Instant(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) {
    return null;
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

  if (
    year < 1 ||
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  const epochMilliseconds = Date.parse(value);
  return Number.isFinite(epochMilliseconds) ? epochMilliseconds : null;
}

/**
 * Purely maps a Google SubscriptionPurchaseV2 resource to lifecycle facts.
 *
 * `revoked` is intentionally never produced: an EXPIRED resource does not say
 * whether expiry was natural, revoked, refunded, or charged back. That cause
 * needs later reconciliation with RTDN, TOWN revoke records, and voided purchases.
 */
export function mapSubscriptionPurchaseToNeutralFacts(
  subscription: unknown,
): SubscriptionPurchaseFactsResult {
  if (!isRecord(subscription)) {
    return { ok: false, reason: 'subscription_purchase_v2_not_object' };
  }

  const input: SubscriptionPurchaseV2Input = subscription;
  if (typeof input.subscriptionState !== 'string' || input.subscriptionState.length === 0) {
    return { ok: false, reason: 'subscription_state_missing' };
  }

  let state: AuthoritativeSubscriptionFacts['state'];
  switch (input.subscriptionState) {
    case GOOGLE_PLAY_SUBSCRIPTION_STATE_ACTIVE:
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      state = 'active';
      break;
    case 'SUBSCRIPTION_STATE_CANCELED':
      state = 'cancelled';
      break;
    case 'SUBSCRIPTION_STATE_ON_HOLD':
      state = 'on_hold';
      break;
    case 'SUBSCRIPTION_STATE_PAUSED':
      state = 'paused';
      break;
    case 'SUBSCRIPTION_STATE_EXPIRED':
      state = 'expired';
      break;
    case 'SUBSCRIPTION_STATE_PENDING':
      state = 'pending';
      break;
    case 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED':
      // Fail-closed collapse: it grants no entitlement. Reconciliation of a prior
      // subscription through linkedPurchaseToken is a separate, later slice.
      state = 'expired';
      break;
    case 'SUBSCRIPTION_STATE_UNSPECIFIED':
    default:
      return { ok: false, reason: 'subscription_state_unsupported' };
  }

  if (!Array.isArray(input.lineItems) || input.lineItems.length === 0) {
    return { ok: false, reason: 'subscription_line_items_missing' };
  }

  let expiry: number | null = null;
  for (const lineItem of input.lineItems) {
    if (!isRecord(lineItem)) {
      return { ok: false, reason: 'subscription_line_item_invalid' };
    }
    const item: SubscriptionPurchaseLineItemInput = lineItem;
    if (typeof item.expiryTime !== 'string' || item.expiryTime.length === 0) {
      return { ok: false, reason: 'subscription_expiry_time_missing' };
    }

    const lineItemExpiry = parseRfc3339Instant(item.expiryTime);
    if (lineItemExpiry === null) {
      return { ok: false, reason: 'subscription_expiry_time_invalid' };
    }
    expiry = expiry === null ? lineItemExpiry : Math.max(expiry, lineItemExpiry);
  }

  return { ok: true, facts: { state, expiry } };
}
