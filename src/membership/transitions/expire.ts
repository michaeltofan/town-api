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

const expireLogic: TransitionLogic = {
  eventType: 'expire',
  validate(ctx: TransitionContext) {
    const entitlement = ctx.entitlement;
    if (!entitlement || !['active', 'cancelling'].includes(entitlement.status)) {
      return { kind: 'reject', reason: 'not_active_or_cancelling' };
    }

    if (
      !entitlement.accessUntil ||
      new Date(ctx.input.effectiveAt).getTime() < new Date(entitlement.accessUntil).getTime()
    ) {
      return { kind: 'reject', reason: 'expire_too_early' };
    }

    if (
      entitlement.expiredAt &&
      new Date(ctx.input.effectiveAt).getTime() < new Date(entitlement.expiredAt).getTime()
    ) {
      return { kind: 'stale', reason: 'older_expire_event' };
    }

    return { kind: 'apply' };
  },
  apply(ctx: TransitionContext) {
    const entitlement = ctx.entitlement!;
    return {
      status: 'expired' as const,
      accessUntil: entitlement.accessUntil,
      cancelAtPeriodEnd: false,
      source: entitlement.source as import('../../db/schema.js').MembershipSource,
      sourceCustomerId: entitlement.sourceCustomerId,
      sourceSubscriptionId: entitlement.sourceSubscriptionId,
      activatedAt: entitlement.activatedAt,
      cancellationRequestedAt: null,
      expiredAt: ctx.input.effectiveAt,
      version: entitlement.version + 1,
    };
  },
  appliedAuditEventType: 'membership_expired',
  replayedAuditEventType: 'membership_event_replayed',
  rejectedAuditEventType: 'membership_event_rejected',
};

export async function expireMembership(
  db: Db,
  input: MembershipTransitionInput,
  deps: MembershipTransitionDeps = {},
): Promise<MembershipTransitionOutcome> {
  return executeMembershipTransition(
    db,
    { ...input, eventType: 'expire' },
    expireLogic,
    deps,
  );
}
