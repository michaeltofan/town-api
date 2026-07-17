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

const activateLogic: TransitionLogic = {
  eventType: 'activate',
  isCreation: (ctx) => ctx.entitlement === null,
  validate(ctx: TransitionContext) {
    if (ctx.account.status === 'closed') {
      return { kind: 'reject', reason: 'account_closed' };
    }

    const accessUntil = ctx.input.accessUntil;
    if (!accessUntil) {
      return { kind: 'reject', reason: 'access_until_required' };
    }

    if (new Date(accessUntil).getTime() <= new Date(ctx.input.effectiveAt).getTime()) {
      return { kind: 'reject', reason: 'access_until_must_exceed_effective_at' };
    }

    const status = ctx.entitlement?.status ?? 'inactive';

    if (status === 'active') {
      const currentUntil = ctx.entitlement!.accessUntil;
      if (!currentUntil) {
        return { kind: 'reject', reason: 'active_missing_access_until' };
      }
      if (new Date(accessUntil).getTime() < new Date(currentUntil).getTime()) {
        return { kind: 'stale', reason: 'would_reduce_access_until' };
      }
      if (
        new Date(ctx.input.effectiveAt).getTime() < new Date(ctx.entitlement!.updatedAt).getTime()
      ) {
        return { kind: 'stale', reason: 'older_event_overrides_newer_state' };
      }
      return { kind: 'apply' };
    }

    if (status === 'inactive' || status === 'expired' || status === 'cancelling' || !ctx.entitlement) {
      return { kind: 'apply' };
    }

    return { kind: 'reject', reason: 'invalid_status_for_activate' };
  },
  apply(ctx: TransitionContext) {
    const accessUntil = ctx.input.accessUntil!;
    const previous = ctx.entitlement;
    const nextVersion = (previous?.version ?? 0) + 1;

    return {
      status: 'active' as const,
      accessUntil,
      cancelAtPeriodEnd: false,
      source: ctx.input.source,
      sourceCustomerId: ctx.input.sourceCustomerId ?? previous?.sourceCustomerId ?? null,
      sourceSubscriptionId:
        ctx.input.sourceSubscriptionId ?? previous?.sourceSubscriptionId ?? null,
      activatedAt: previous?.activatedAt ?? ctx.input.effectiveAt,
      cancellationRequestedAt: null,
      expiredAt: null,
      version: nextVersion,
    };
  },
  appliedAuditEventType: 'membership_activated',
  replayedAuditEventType: 'membership_event_replayed',
  rejectedAuditEventType: 'membership_event_rejected',
};

export async function activateMembership(
  db: Db,
  input: MembershipTransitionInput,
  deps: MembershipTransitionDeps = {},
): Promise<MembershipTransitionOutcome> {
  return executeMembershipTransition(
    db,
    { ...input, eventType: 'activate' },
    activateLogic,
    deps,
  );
}
