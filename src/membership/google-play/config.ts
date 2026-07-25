import type { Env } from '../../config/env.js';
import {
  createOfficialGooglePlayAndroidPublisherAdapter,
  type TownGooglePlayAndroidPublisherAdapter,
} from './android-publisher-adapter.js';
import type { GooglePlayVerifyPurchaseConfig } from './verify-purchase.js';

export function resolveGooglePlayVerifyPurchaseConfig(
  env: Pick<
    Env,
    'GOOGLE_PLAY_BILLING_ENABLED' | 'GOOGLE_PLAY_PACKAGE_NAME' | 'GOOGLE_PLAY_SUBSCRIPTION_ID'
  >,
): GooglePlayVerifyPurchaseConfig {
  return {
    enabled: env.GOOGLE_PLAY_BILLING_ENABLED,
    packageName: env.GOOGLE_PLAY_PACKAGE_NAME ?? '',
    subscriptionId: env.GOOGLE_PLAY_SUBSCRIPTION_ID ?? '',
  };
}

/**
 * Construct the production Android Publisher adapter when Google Play billing is enabled.
 * Callers must not invoke this when disabled; verification already fail-closes on disabled.
 */
export function createGooglePlayAndroidPublisherAdapterFromEnv(
  env: Pick<Env, 'GOOGLE_PLAY_BILLING_ENABLED' | 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'>,
): TownGooglePlayAndroidPublisherAdapter {
  if (!env.GOOGLE_PLAY_BILLING_ENABLED) {
    throw new Error(
      'Google Play Android Publisher adapter requires GOOGLE_PLAY_BILLING_ENABLED=true',
    );
  }
  const serviceAccountJson = env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson || serviceAccountJson.length === 0) {
    throw new Error(
      'Google Play Android Publisher adapter requires GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
    );
  }
  return createOfficialGooglePlayAndroidPublisherAdapter({
    serviceAccountJson,
  });
}
