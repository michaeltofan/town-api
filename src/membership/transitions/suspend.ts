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

const suspendLogic: TransitionLogic = {
  eventType: 'suspend',
  validate(ctx: TransitionContext) {
    const entitlement = ctx.entitlement;
    if (!entitlement || !['active', 'cancelling'].includes(entitlement.status)) {
      return { kind: 'reject', reason: 'not_suspendable' };
    }

    return { kind: 'apply' };
  },
  apply(ctx: TransitionContext) {
    const entitlement = ctx.entitlement;
    if (!entitlement) {
      throw new Error(
        'suspend.apply requires an existing entitlement; validate must reject earlier',
      );
    }
    return {
      status: 'suspended' as const,
      accessUntil: entitlement.accessUntil,
      cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
      source: entitlement.source as import('../../db/schema.js').MembershipSource,
      sourceCustomerId: entitlement.sourceCustomerId,
      sourceSubscriptionId: entitlement.sourceSubscriptionId,
      activatedAt: entitlement.activatedAt,
      cancellationRequestedAt: entitlement.cancellationRequestedAt,
      expiredAt: entitlement.expiredAt,
      version: entitlement.version + 1,
    };
  },
  appliedAuditEventType: 'membership_suspended',
  replayedAuditEventType: 'membership_event_replayed',
  rejectedAuditEventType: 'membership_event_rejected',
};

export async function suspendMembership(
  db: Db,
  input: MembershipTransitionInput,
  deps: MembershipTransitionDeps = {},
): Promise<MembershipTransitionOutcome> {
  return executeMembershipTransition(db, { ...input, eventType: 'suspend' }, suspendLogic, deps);
}
