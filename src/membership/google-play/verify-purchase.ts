import type { TownGooglePlayAndroidPublisherAdapter } from './android-publisher-adapter.js';
import { GooglePlayAndroidPublisherError } from './android-publisher-adapter.js';
import type { VerifiedGooglePlayPurchaseProvisionInput } from './provision-paid-pending-binding.js';
import {
  GOOGLE_PLAY_SUBSCRIPTION_STATE_ACTIVE,
  selectPrimarySubscriptionLineItem,
} from './subscription-purchase-v2.js';

export type GooglePlayVerifyPurchaseInput = {
  accountId: string;
  purchaseToken: string;
  /**
   * Optional client-claimed package name. When provided it must exactly match the
   * configured package name; the configured value is always used for the API call.
   */
  claimedPackageName?: string;
  /**
   * Optional client-claimed product/subscription id. When provided it must match
   * the configured expected subscription id and the verified line-item productId.
   */
  claimedSubscriptionId?: string;
  effectiveAt?: string;
  sourceEventId?: string;
};

export type GooglePlayVerifyPurchaseConfig = {
  enabled: boolean;
  packageName: string;
  subscriptionId: string;
};

export type GooglePlayVerifyPurchaseResult =
  | {
      ok: true;
      verified: VerifiedGooglePlayPurchaseProvisionInput;
    }
  | {
      ok: false;
      reason: string;
    };

function buildSourceEventId(purchaseToken: string): string {
  return `google_play:subscriptionsv2:${purchaseToken}`;
}

/**
 * Server-side Google Play purchase verification.
 *
 * TRUST BOUNDARY: This is the only module allowed to construct
 * VerifiedGooglePlayPurchaseProvisionInput from untrusted purchase tokens.
 * It always calls the Android Publisher adapter; there is no bypass path.
 */
export async function verifyGooglePlayPurchase(input: {
  purchase: GooglePlayVerifyPurchaseInput;
  config: GooglePlayVerifyPurchaseConfig;
  adapter: TownGooglePlayAndroidPublisherAdapter;
}): Promise<GooglePlayVerifyPurchaseResult> {
  if (!input.config.enabled) {
    return { ok: false, reason: 'google_play_billing_disabled' };
  }

  const purchaseToken = input.purchase.purchaseToken.trim();
  if (purchaseToken.length === 0) {
    return { ok: false, reason: 'purchase_token_required' };
  }

  const accountId = input.purchase.accountId.trim();
  if (accountId.length === 0) {
    return { ok: false, reason: 'account_id_required' };
  }

  const configuredPackageName = input.config.packageName;
  const configuredSubscriptionId = input.config.subscriptionId;
  if (!configuredPackageName || configuredPackageName.length === 0) {
    return { ok: false, reason: 'google_play_package_name_unconfigured' };
  }
  if (!configuredSubscriptionId || configuredSubscriptionId.length === 0) {
    return { ok: false, reason: 'google_play_subscription_id_unconfigured' };
  }

  if (
    input.purchase.claimedPackageName !== undefined &&
    input.purchase.claimedPackageName !== configuredPackageName
  ) {
    return { ok: false, reason: 'package_name_mismatch' };
  }
  if (
    input.purchase.claimedSubscriptionId !== undefined &&
    input.purchase.claimedSubscriptionId !== configuredSubscriptionId
  ) {
    return { ok: false, reason: 'subscription_id_claim_mismatch' };
  }

  const effectiveAt = input.purchase.effectiveAt ?? new Date().toISOString();

  let remote;
  try {
    remote = await input.adapter.getSubscriptionV2({
      packageName: configuredPackageName,
      purchaseToken,
    });
  } catch (error) {
    if (error instanceof GooglePlayAndroidPublisherError) {
      if (error.code === 'GOOGLE_PLAY_HTTP_ERROR' && error.httpStatus === 404) {
        return { ok: false, reason: 'purchase_not_found' };
      }
      return { ok: false, reason: 'google_play_verification_transport_failed' };
    }
    return { ok: false, reason: 'google_play_verification_transport_failed' };
  }

  if (remote.subscriptionState !== GOOGLE_PLAY_SUBSCRIPTION_STATE_ACTIVE) {
    return { ok: false, reason: 'subscription_not_active' };
  }

  const lineItem = selectPrimarySubscriptionLineItem(remote);
  if (!lineItem) {
    return { ok: false, reason: 'subscription_line_items_missing' };
  }

  if (lineItem.productId !== configuredSubscriptionId) {
    return { ok: false, reason: 'subscription_product_id_mismatch' };
  }

  if (new Date(lineItem.expiryTime).getTime() <= new Date(effectiveAt).getTime()) {
    return { ok: false, reason: 'subscription_expired' };
  }

  return {
    ok: true,
    verified: {
      sourceEventId: input.purchase.sourceEventId ?? buildSourceEventId(purchaseToken),
      accountId,
      effectiveAt,
      accessUntil: lineItem.expiryTime,
      purchaseToken,
      packageName: configuredPackageName,
      subscriptionId: lineItem.productId,
    },
  };
}
