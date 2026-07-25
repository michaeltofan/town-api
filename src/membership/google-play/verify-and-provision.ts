import type { Database } from '../../db/client.js';
import type { TownGooglePlayAndroidPublisherAdapter } from './android-publisher-adapter.js';
import {
  provisionGooglePlayPaidPendingBinding,
  type ProvisionGooglePlayPaidPendingBindingDeps,
  type ProvisionGooglePlayPaidPendingBindingOutcome,
} from './provision-paid-pending-binding.js';
import { GOOGLE_PLAY_ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED } from './subscription-purchase-v2.js';
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

export type GooglePlayAcknowledgementStatus = 'acknowledged' | 'already_acknowledged' | 'failed';

export type VerifyAndProvisionGooglePlayPurchaseOutcome =
  | (ProvisionGooglePlayPaidPendingBindingOutcome & {
      verification: 'verified';
      acknowledgement?: GooglePlayAcknowledgementStatus;
      acknowledgementReason?: string;
    })
  | {
      result: 'rejected';
      reason: string;
      verification: 'failed';
    };

function isDurableProvisionSuccess(
  outcome: ProvisionGooglePlayPaidPendingBindingOutcome,
): outcome is ProvisionGooglePlayPaidPendingBindingOutcome & {
  result: 'applied' | 'replayed';
} {
  return outcome.result === 'applied' || outcome.result === 'replayed';
}

async function acknowledgeAfterDurableProvision(input: {
  adapter: TownGooglePlayAndroidPublisherAdapter;
  packageName: string;
  subscriptionId: string;
  purchaseToken: string;
  acknowledgementState: string | undefined;
}): Promise<{
  acknowledgement: GooglePlayAcknowledgementStatus;
  acknowledgementReason?: string;
}> {
  if (input.acknowledgementState === GOOGLE_PLAY_ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED) {
    return { acknowledgement: 'already_acknowledged' };
  }

  try {
    const result = await input.adapter.acknowledgeSubscription({
      packageName: input.packageName,
      subscriptionId: input.subscriptionId,
      purchaseToken: input.purchaseToken,
    });
    return { acknowledgement: result.status };
  } catch (error) {
    void error;
    return {
      acknowledgement: 'failed',
      acknowledgementReason: 'google_play_acknowledgement_transport_failed',
    };
  }
}

/**
 * Verify a Google Play purchase via Android Publisher subscriptionsv2.get, then
 * provision paid_pending_binding through the existing internal provisioner.
 * After a durable applied/replayed provision outcome, acknowledge the purchase.
 *
 * Never bypasses verification. Never acknowledges after verification failure,
 * provision rejection, or rollback. Fail-closed when disabled, misconfigured,
 * or when Google verification fails.
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

  if (!isDurableProvisionSuccess(outcome)) {
    return {
      ...outcome,
      verification: 'verified',
    };
  }

  const acknowledgement = await acknowledgeAfterDurableProvision({
    adapter: deps.adapter,
    packageName: verified.verified.packageName,
    subscriptionId: verified.verified.subscriptionId,
    purchaseToken: verified.verified.purchaseToken,
    acknowledgementState: verified.acknowledgementState,
  });

  return {
    ...outcome,
    verification: 'verified',
    ...acknowledgement,
  };
}
