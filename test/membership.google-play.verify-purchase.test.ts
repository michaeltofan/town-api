import { describe, expect, it } from 'vitest';
import {
  createFakeGooglePlayAndroidPublisherAdapter,
  createFakeGooglePlayAndroidPublisherState,
  GooglePlayAndroidPublisherError,
  setFakeGooglePlaySubscription,
} from '../src/membership/google-play/android-publisher-adapter.js';
import { parseSubscriptionPurchaseV2 } from '../src/membership/google-play/subscription-purchase-v2.js';
import { verifyGooglePlayPurchase } from '../src/membership/google-play/verify-purchase.js';

const PACKAGE_NAME = 'com.town.town_safe_space_mobile';
const SUBSCRIPTION_ID = 'town_annual_membership';
const ACCOUNT_ID = '11000000-0000-4000-8000-000000000601';
const TOKEN = 'gp_token_verify_unit_1';
const NOW = '2026-07-25T12:00:00.000Z';
const ACCESS_UNTIL = '2027-07-25T12:00:00.000Z';

function enabledConfig() {
  return {
    enabled: true,
    packageName: PACKAGE_NAME,
    subscriptionId: SUBSCRIPTION_ID,
  };
}

describe('parseSubscriptionPurchaseV2', () => {
  it('accepts a minimal valid SubscriptionPurchaseV2 payload', () => {
    const parsed = parseSubscriptionPurchaseV2({
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      lineItems: [{ productId: SUBSCRIPTION_ID, expiryTime: ACCESS_UNTIL }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.purchase.lineItems[0]?.productId).toBe(SUBSCRIPTION_ID);
    }
  });

  it('rejects missing line items fail-closed', () => {
    expect(
      parseSubscriptionPurchaseV2({
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
        lineItems: [],
      }),
    ).toEqual({ ok: false, reason: 'subscription_line_items_missing' });
  });
});

describe('verifyGooglePlayPurchase', () => {
  it('fail-closes when Google Play billing is disabled and never calls the adapter', async () => {
    let called = false;
    const adapter = {
      getSubscriptionV2: () => {
        called = true;
        return Promise.reject(new Error('should not be called'));
      },
    };
    const result = await verifyGooglePlayPurchase({
      purchase: {
        accountId: ACCOUNT_ID,
        purchaseToken: TOKEN,
        effectiveAt: NOW,
      },
      config: {
        enabled: false,
        packageName: PACKAGE_NAME,
        subscriptionId: SUBSCRIPTION_ID,
      },
      adapter,
    });
    expect(result).toEqual({ ok: false, reason: 'google_play_billing_disabled' });
    expect(called).toBe(false);
  });

  it('maps an active verified purchase into VerifiedGooglePlayPurchaseProvisionInput', async () => {
    const state = createFakeGooglePlayAndroidPublisherState();
    setFakeGooglePlaySubscription(state, {
      packageName: PACKAGE_NAME,
      purchaseToken: TOKEN,
      purchase: {
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
        lineItems: [{ productId: SUBSCRIPTION_ID, expiryTime: ACCESS_UNTIL }],
      },
    });
    const result = await verifyGooglePlayPurchase({
      purchase: {
        accountId: ACCOUNT_ID,
        purchaseToken: TOKEN,
        effectiveAt: NOW,
        claimedPackageName: PACKAGE_NAME,
        claimedSubscriptionId: SUBSCRIPTION_ID,
      },
      config: enabledConfig(),
      adapter: createFakeGooglePlayAndroidPublisherAdapter(state),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verified).toEqual({
        sourceEventId: `google_play:subscriptionsv2:${TOKEN}`,
        accountId: ACCOUNT_ID,
        effectiveAt: NOW,
        accessUntil: ACCESS_UNTIL,
        purchaseToken: TOKEN,
        packageName: PACKAGE_NAME,
        subscriptionId: SUBSCRIPTION_ID,
      });
    }
  });

  it('rejects non-active subscription states', async () => {
    const state = createFakeGooglePlayAndroidPublisherState();
    setFakeGooglePlaySubscription(state, {
      packageName: PACKAGE_NAME,
      purchaseToken: TOKEN,
      purchase: {
        subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
        lineItems: [{ productId: SUBSCRIPTION_ID, expiryTime: ACCESS_UNTIL }],
      },
    });
    const result = await verifyGooglePlayPurchase({
      purchase: { accountId: ACCOUNT_ID, purchaseToken: TOKEN, effectiveAt: NOW },
      config: enabledConfig(),
      adapter: createFakeGooglePlayAndroidPublisherAdapter(state),
    });
    expect(result).toEqual({ ok: false, reason: 'subscription_not_active' });
  });

  it('rejects product id mismatch against configured subscription id', async () => {
    const state = createFakeGooglePlayAndroidPublisherState();
    setFakeGooglePlaySubscription(state, {
      packageName: PACKAGE_NAME,
      purchaseToken: TOKEN,
      purchase: {
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
        lineItems: [{ productId: 'other_product', expiryTime: ACCESS_UNTIL }],
      },
    });
    const result = await verifyGooglePlayPurchase({
      purchase: { accountId: ACCOUNT_ID, purchaseToken: TOKEN, effectiveAt: NOW },
      config: enabledConfig(),
      adapter: createFakeGooglePlayAndroidPublisherAdapter(state),
    });
    expect(result).toEqual({ ok: false, reason: 'subscription_product_id_mismatch' });
  });

  it('rejects claimed package name mismatches without calling Google', async () => {
    let called = false;
    const result = await verifyGooglePlayPurchase({
      purchase: {
        accountId: ACCOUNT_ID,
        purchaseToken: TOKEN,
        claimedPackageName: 'com.other.app',
        effectiveAt: NOW,
      },
      config: enabledConfig(),
      adapter: {
        getSubscriptionV2: () => {
          called = true;
          return Promise.reject(new Error('should not be called'));
        },
      },
    });
    expect(result).toEqual({ ok: false, reason: 'package_name_mismatch' });
    expect(called).toBe(false);
  });

  it('rejects expired subscriptions', async () => {
    const state = createFakeGooglePlayAndroidPublisherState();
    setFakeGooglePlaySubscription(state, {
      packageName: PACKAGE_NAME,
      purchaseToken: TOKEN,
      purchase: {
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
        lineItems: [{ productId: SUBSCRIPTION_ID, expiryTime: '2026-07-25T11:00:00.000Z' }],
      },
    });
    const result = await verifyGooglePlayPurchase({
      purchase: { accountId: ACCOUNT_ID, purchaseToken: TOKEN, effectiveAt: NOW },
      config: enabledConfig(),
      adapter: createFakeGooglePlayAndroidPublisherAdapter(state),
    });
    expect(result).toEqual({ ok: false, reason: 'subscription_expired' });
  });

  it('maps Google 404 transport failures to purchase_not_found', async () => {
    const state = createFakeGooglePlayAndroidPublisherState();
    state.errorHooks.getSubscriptionV2 = () =>
      new GooglePlayAndroidPublisherError(
        'GOOGLE_PLAY_HTTP_ERROR',
        'Google Play Android Publisher returned a non-success status',
        404,
      );
    const result = await verifyGooglePlayPurchase({
      purchase: { accountId: ACCOUNT_ID, purchaseToken: TOKEN, effectiveAt: NOW },
      config: enabledConfig(),
      adapter: createFakeGooglePlayAndroidPublisherAdapter(state),
    });
    expect(result).toEqual({ ok: false, reason: 'purchase_not_found' });
  });

  it('fail-closes on adapter transport errors without constructing verified input', async () => {
    const state = createFakeGooglePlayAndroidPublisherState();
    state.errorHooks.getSubscriptionV2 = () => new Error('network down');
    const result = await verifyGooglePlayPurchase({
      purchase: { accountId: ACCOUNT_ID, purchaseToken: TOKEN, effectiveAt: NOW },
      config: enabledConfig(),
      adapter: createFakeGooglePlayAndroidPublisherAdapter(state),
    });
    expect(result).toEqual({
      ok: false,
      reason: 'google_play_verification_transport_failed',
    });
  });
});
