import type { Database } from '../../db/client.js';
import {
  executeMembershipTransition,
  type MembershipTransitionDeps,
  type MembershipTransitionInput,
  type MembershipTransitionOutcome,
  type TransitionContext,
  type TransitionLogic,
} from './shared.js';

type Db = Database['db'];

/**
 * Dedicated paid_pending_binding → active finalisation.
 *
 * Intentionally separate from activate: activate must not accept
 * paid_pending_binding, and finalisation must not broaden activate's
 * allowed-from statuses.
 */
const finalizePaidPendingBindingLogic: TransitionLogic = {
  eventType: 'finalize_paid_pending_binding',
  validate(ctx: TransitionContext) {
    if (ctx.account.status === 'closed') {
      return { kind: 'reject', reason: 'account_closed' };
    }

    const entitlement = ctx.entitlement;
    if (!entitlement) {
      return { kind: 'reject', reason: 'entitlement_missing' };
    }

    if (entitlement.status !== 'paid_pending_binding') {
      return { kind: 'reject', reason: 'invalid_status_for_finalize_paid_pending_binding' };
    }

    if (!entitlement.accessUntil) {
      return { kind: 'reject', reason: 'access_until_required' };
    }

    if (new Date(entitlement.accessUntil).getTime() <= new Date(ctx.input.effectiveAt).getTime()) {
      return { kind: 'reject', reason: 'access_until_must_exceed_effective_at' };
    }

    const proposedAccessUntil = ctx.input.accessUntil;
    if (!proposedAccessUntil) {
      return { kind: 'reject', reason: 'access_until_required' };
    }

    if (new Date(proposedAccessUntil).getTime() !== new Date(entitlement.accessUntil).getTime()) {
      return { kind: 'reject', reason: 'access_until_mismatch' };
    }

    return { kind: 'apply' };
  },
  apply(ctx: TransitionContext) {
    const entitlement = ctx.entitlement;
    if (!entitlement) {
      throw new Error(
        'finalize_paid_pending_binding.apply requires an existing entitlement; validate must reject earlier',
      );
    }
    if (!entitlement.accessUntil) {
      throw new Error(
        'finalize_paid_pending_binding.apply requires accessUntil; validate must have rejected earlier',
      );
    }

    return {
      status: 'active' as const,
      accessUntil: entitlement.accessUntil,
      cancelAtPeriodEnd: false,
      source: entitlement.source as import('../../db/schema.js').MembershipSource,
      sourceCustomerId: entitlement.sourceCustomerId,
      sourceSubscriptionId: entitlement.sourceSubscriptionId,
      activatedAt: ctx.input.effectiveAt,
      cancellationRequestedAt: null,
      expiredAt: null,
      version: entitlement.version + 1,
    };
  },
  // Reuse membership_activated: finalisation is the activation moment for this path.
  appliedAuditEventType: 'membership_activated',
  replayedAuditEventType: 'membership_event_replayed',
  rejectedAuditEventType: 'membership_event_rejected',
};

export async function finalizePaidPendingBindingMembership(
  db: Db,
  input: MembershipTransitionInput,
  deps: MembershipTransitionDeps = {},
): Promise<MembershipTransitionOutcome> {
  return executeMembershipTransition(
    db,
    { ...input, eventType: 'finalize_paid_pending_binding' },
    finalizePaidPendingBindingLogic,
    deps,
  );
}
