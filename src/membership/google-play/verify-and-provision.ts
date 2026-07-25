import type { Database } from '../../db/client.js';
import type { TownGooglePlayAndroidPublisherAdapter } from './android-publisher-adapter.js';
import {
  provisionGooglePlayPaidPendingBinding,
  type ProvisionGooglePlayPaidPendingBindingDeps,
  type ProvisionGooglePlayPaidPendingBindingOutcome,
} from './provision-paid-pending-binding.js';
import {
  verifyGooglePlayPurchase,
  type GooglePlayVerifyPurchaseConfig,
  type GooglePlayVerifyPurchaseInput,
} from './verify-purchase.js';

type Db = Database['db'];

export type VerifyAndProvisionGooglePlayPurchaseDeps = ProvisionGooglePlayPaidPendingBindingDeps & {
  adapter: TownGooglePlayAndroidPublisherAdapter;
  config: GooglePlayVerifyPurchaseConfig;
};

export type VerifyAndProvisionGooglePlayPurchaseOutcome =
  | (ProvisionGooglePlayPaidPendingBindingOutcome & {
      verification: 'verified';
    })
  | {
      result: 'rejected';
      reason: string;
      verification: 'failed';
    };

/**
 * Verify a Google Play purchase via Android Publisher subscriptionsv2.get, then
 * provision paid_pending_binding through the existing internal provisioner.
 *
 * Never bypasses verification. Never exposes a public route. Fail-closed when
 * disabled, misconfigured, or when Google verification fails.
 */
export async function verifyAndProvisionGooglePlayPurchase(
  db: Db,
  purchase: GooglePlayVerifyPurchaseInput,
  deps: VerifyAndProvisionGooglePlayPurchaseDeps,
): Promise<VerifyAndProvisionGooglePlayPurchaseOutcome> {
  const verified = await verifyGooglePlayPurchase({
    purchase,
    config: deps.config,
    adapter: deps.adapter,
  });

  if (!verified.ok) {
    return {
      result: 'rejected',
      reason: verified.reason,
      verification: 'failed',
    };
  }

  const outcome = await provisionGooglePlayPaidPendingBinding(db, verified.verified, {
    ...(deps.nodeEnv !== undefined ? { nodeEnv: deps.nodeEnv } : {}),
    ...(deps.generateId ? { generateId: deps.generateId } : {}),
    ...(deps.requestId !== undefined ? { requestId: deps.requestId } : {}),
    ...(deps.processedAt !== undefined ? { processedAt: deps.processedAt } : {}),
  });

  return {
    ...outcome,
    verification: 'verified',
  };
}
