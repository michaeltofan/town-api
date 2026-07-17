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

const reactivateLogic: TransitionLogic = {
  eventType: 'reactivate',
  validate(ctx: TransitionContext) {
    const entitlement = ctx.entitlement;
    if (entitlement?.status !== 'cancelling') {
      return { kind: 'reject', reason: 'not_cancelling' };
    }

    if (
      !entitlement.accessUntil ||
      new Date(ctx.input.effectiveAt).getTime() >= new Date(entitlement.accessUntil).getTime()
    ) {
      return { kind: 'reject', reason: 'not_temporally_active' };
    }

    if (
      entitlement.cancellationRequestedAt &&
      new Date(ctx.input.effectiveAt).getTime() <
        new Date(entitlement.cancellationRequestedAt).getTime()
    ) {
      return { kind: 'stale', reason: 'older_reactivation_event' };
    }

    return { kind: 'apply' };
  },
  apply(ctx: TransitionContext) {
    const entitlement = ctx.entitlement;
    if (!entitlement) {
      throw new Error(
        'reactivate.apply requires an existing entitlement; validate must reject earlier',
      );
    }
    return {
      status: 'active' as const,
      accessUntil: entitlement.accessUntil,
      cancelAtPeriodEnd: false,
      source: entitlement.source as import('../../db/schema.js').MembershipSource,
      sourceCustomerId: entitlement.sourceCustomerId,
      sourceSubscriptionId: entitlement.sourceSubscriptionId,
      activatedAt: entitlement.activatedAt,
      cancellationRequestedAt: null,
      expiredAt: null,
      version: entitlement.version + 1,
    };
  },
  appliedAuditEventType: 'membership_reactivated',
  replayedAuditEventType: 'membership_event_replayed',
  rejectedAuditEventType: 'membership_event_rejected',
};

export async function reactivateMembership(
  db: Db,
  input: MembershipTransitionInput,
  deps: MembershipTransitionDeps = {},
): Promise<MembershipTransitionOutcome> {
  return executeMembershipTransition(
    db,
    { ...input, eventType: 'reactivate' },
    reactivateLogic,
    deps,
  );
}
