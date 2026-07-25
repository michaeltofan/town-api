/**
 * Minimal SubscriptionPurchaseV2 shapes used by the S2 verifier.
 * Source of truth: Google Play Developer API purchases.subscriptionsv2.get.
 */

export const GOOGLE_PLAY_SUBSCRIPTION_STATE_ACTIVE = 'SUBSCRIPTION_STATE_ACTIVE' as const;

export type GooglePlaySubscriptionPurchaseLineItem = {
  productId: string;
  expiryTime: string;
};

export type GooglePlaySubscriptionPurchaseV2 = {
  subscriptionState: string;
  lineItems: GooglePlaySubscriptionPurchaseLineItem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Parse and validate the subset of SubscriptionPurchaseV2 required for
 * paid_pending_binding provisioning. Rejects unknown/incomplete payloads fail-closed.
 */
export function parseSubscriptionPurchaseV2(
  value: unknown,
): { ok: true; purchase: GooglePlaySubscriptionPurchaseV2 } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: 'subscription_purchase_v2_not_object' };
  }

  if (!isNonEmptyString(value.subscriptionState)) {
    return { ok: false, reason: 'subscription_state_missing' };
  }

  if (!Array.isArray(value.lineItems) || value.lineItems.length === 0) {
    return { ok: false, reason: 'subscription_line_items_missing' };
  }

  const lineItems: GooglePlaySubscriptionPurchaseLineItem[] = [];
  for (const item of value.lineItems) {
    if (!isRecord(item)) {
      return { ok: false, reason: 'subscription_line_item_invalid' };
    }
    if (!isNonEmptyString(item.productId)) {
      return { ok: false, reason: 'subscription_product_id_missing' };
    }
    if (!isNonEmptyString(item.expiryTime)) {
      return { ok: false, reason: 'subscription_expiry_time_missing' };
    }
    const expiryMs = Date.parse(item.expiryTime);
    if (Number.isNaN(expiryMs)) {
      return { ok: false, reason: 'subscription_expiry_time_invalid' };
    }
    lineItems.push({
      productId: item.productId,
      expiryTime: item.expiryTime,
    });
  }

  return {
    ok: true,
    purchase: {
      subscriptionState: value.subscriptionState,
      lineItems,
    },
  };
}

export function selectPrimarySubscriptionLineItem(
  purchase: GooglePlaySubscriptionPurchaseV2,
): GooglePlaySubscriptionPurchaseLineItem | null {
  return purchase.lineItems[0] ?? null;
}
