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

const scheduleCancellationLogic: TransitionLogic = {
  eventType: 'schedule_cancellation',
  validate(ctx: TransitionContext) {
    const entitlement = ctx.entitlement;
    if (entitlement?.status !== 'active') {
      return { kind: 'reject', reason: 'not_active' };
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
      return { kind: 'stale', reason: 'older_cancellation_event' };
    }

    return { kind: 'apply' };
  },
  apply(ctx: TransitionContext) {
    const entitlement = ctx.entitlement;
    if (!entitlement) {
      throw new Error(
        'schedule-cancellation.apply requires an existing entitlement; validate must reject earlier',
      );
    }
    return {
      status: 'cancelling' as const,
      accessUntil: entitlement.accessUntil,
      cancelAtPeriodEnd: true,
      source: entitlement.source as import('../../db/schema.js').MembershipSource,
      sourceCustomerId: entitlement.sourceCustomerId,
      sourceSubscriptionId: entitlement.sourceSubscriptionId,
      activatedAt: entitlement.activatedAt,
      cancellationRequestedAt: ctx.input.effectiveAt,
      expiredAt: null,
      version: entitlement.version + 1,
    };
  },
  appliedAuditEventType: 'membership_cancellation_scheduled',
  replayedAuditEventType: 'membership_event_replayed',
  rejectedAuditEventType: 'membership_event_rejected',
};

export async function scheduleMembershipCancellation(
  db: Db,
  input: MembershipTransitionInput,
  deps: MembershipTransitionDeps = {},
): Promise<MembershipTransitionOutcome> {
  return executeMembershipTransition(
    db,
    { ...input, eventType: 'schedule_cancellation' },
    scheduleCancellationLogic,
    deps,
  );
}
