import type { Database } from '../db/client.js';
import { findActiveCivicActorByAccountId } from '../db/repositories/confirmations.js';
import type { MembershipEntitlementRow, MembershipSource } from '../db/schema.js';
import { findEntitlementByAccountId } from './repositories/entitlements.js';
import { finalizePaidPendingBindingMembership } from './transitions/finalize-paid-pending-binding.js';
import type {
  MembershipTransitionDeps,
  MembershipTransitionOutcome,
} from './transitions/shared.js';

type Db = Database['db'];

export type FinalizeAfterCommunityBindInput = {
  accountId: string;
  communityId: string;
  effectiveAt: string;
};

export type FinalizeAfterCommunityBindOutcome =
  | {
      result: 'skipped';
      reason:
        | 'community_binding_preconditions_unmet'
        | 'not_paid_pending_binding'
        | 'entitlement_missing';
      entitlement?: MembershipEntitlementRow;
    }
  | MembershipTransitionOutcome;

export function buildFinalizePaidPendingBindingSourceEventId(input: {
  accountId: string;
  communityId: string;
}): string {
  return `finalize_paid_pending_binding:${input.accountId}:${input.communityId}`;
}

/**
 * Attempt paid_pending_binding → active finalisation only after community
 * binding and local-eligibility preconditions are already satisfied.
 *
 * Skips without writing a membership source event when preconditions are unmet
 * or the entitlement is not paid_pending_binding, so a bind-before-purchase
 * sequence does not poison idempotency for a later finalisation attempt.
 *
 * Never invoked from the Google Play purchase ingress; purchase remains
 * paid_pending_binding-only (S1–S4).
 */
export async function maybeFinalizePaidPendingBindingAfterCommunityBind(
  db: Db,
  input: FinalizeAfterCommunityBindInput,
  deps: MembershipTransitionDeps = {},
): Promise<FinalizeAfterCommunityBindOutcome> {
  const actor = await findActiveCivicActorByAccountId(db, input.accountId);
  if (actor?.communityId !== input.communityId || actor.localEligibilityVerifiedAt === null) {
    return { result: 'skipped', reason: 'community_binding_preconditions_unmet' };
  }

  const entitlement = await findEntitlementByAccountId(db, input.accountId);
  if (!entitlement) {
    return { result: 'skipped', reason: 'entitlement_missing' };
  }

  if (entitlement.status !== 'paid_pending_binding') {
    return {
      result: 'skipped',
      reason: 'not_paid_pending_binding',
      entitlement,
    };
  }

  if (!entitlement.accessUntil) {
    return {
      result: 'skipped',
      reason: 'not_paid_pending_binding',
      entitlement,
    };
  }

  return finalizePaidPendingBindingMembership(
    db,
    {
      source: entitlement.source as MembershipSource,
      sourceEventId: buildFinalizePaidPendingBindingSourceEventId({
        accountId: input.accountId,
        communityId: input.communityId,
      }),
      eventType: 'finalize_paid_pending_binding',
      accountId: input.accountId,
      effectiveAt: input.effectiveAt,
      accessUntil: entitlement.accessUntil,
      sourceCustomerId: entitlement.sourceCustomerId,
      sourceSubscriptionId: entitlement.sourceSubscriptionId,
    },
    deps,
  );
}
