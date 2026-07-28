import type {
  AccountRow,
  ActorRow,
  CivicAccessLevel,
  LocalParticipationEligibility,
  MembershipEntitlementRow,
  MembershipStatus,
} from '../db/schema.js';
import type { CivicAccessEvaluation, ParticipationDenialReason } from './types.js';

export function isMembershipTemporallyValid(
  entitlement: MembershipEntitlementRow | null,
  now: string,
): boolean {
  if (!entitlement?.accessUntil) {
    return false;
  }
  return new Date(now).getTime() < new Date(entitlement.accessUntil).getTime();
}

export function resolveEffectiveMembershipStatus(
  entitlement: MembershipEntitlementRow | null,
  now: string,
): MembershipStatus {
  if (!entitlement) {
    return 'inactive';
  }
  if (
    entitlement.accessUntil &&
    new Date(now).getTime() >= new Date(entitlement.accessUntil).getTime()
  ) {
    return 'expired';
  }
  return entitlement.status as MembershipStatus;
}

function mapLocalEligibilityToDenial(
  localEligibility: LocalParticipationEligibility,
): ParticipationDenialReason | null {
  switch (localEligibility) {
    case 'eligible':
      return null;
    case 'not_verified':
      return 'local_not_verified';
    case 'expired':
      return 'local_expired';
    case 'mismatched_community':
      return 'local_mismatched_community';
    case 'unavailable':
      return 'local_unavailable';
  }
}

/**
 * Owner accounts (`isOwner === true`) bypass membership/payment entitlement checks
 * only. Session, active-account, actor, community, and local-eligibility gates are
 * unchanged. Owner access is the same `participant` level granted for active/cancelling
 * membership — nothing beyond that.
 */
export function evaluateCivicAccess(input: {
  session: null | { accountId: string };
  account: null | Pick<AccountRow, 'id' | 'status' | 'isOwner'>;
  entitlement: null | MembershipEntitlementRow;
  actor: null | Pick<ActorRow, 'id' | 'accountId' | 'communityId' | 'kind' | 'status'>;
  communityId?: string;
  localEligibility: LocalParticipationEligibility;
  now: string;
}): CivicAccessEvaluation {
  if (!input.session) {
    return {
      level: 'visitor',
      canParticipate: false,
      localEligibility: input.localEligibility,
      denialReason: 'no_session',
    };
  }

  const base = {
    level: 'read_only' as CivicAccessLevel,
    canParticipate: false,
    localEligibility: input.localEligibility,
  };

  if (input.account?.id !== input.session.accountId) {
    return {
      ...base,
      denialReason: 'inactive_account',
    };
  }

  if (input.account.status !== 'active') {
    return {
      ...base,
      denialReason: 'inactive_account',
    };
  }

  // Membership/payment gate. Owner label is an alternative path to the same
  // participant outcome; existing entitlement rules stay intact for non-owners.
  const isOwner = input.account.isOwner;
  let effectiveStatus: MembershipStatus | null = null;

  if (!isOwner) {
    if (!input.entitlement) {
      return {
        ...base,
        denialReason: 'no_entitlement',
      };
    }

    effectiveStatus = resolveEffectiveMembershipStatus(input.entitlement, input.now);

    if (effectiveStatus === 'inactive') {
      return {
        ...base,
        denialReason: 'inactive_membership',
      };
    }

    if (effectiveStatus === 'expired') {
      return {
        ...base,
        denialReason: 'expired_membership',
      };
    }

    // Payment alone grants no civic participation. paid_pending_binding is provisioned
    // after a verified purchase but before final community binding completes.
    if (effectiveStatus === 'paid_pending_binding') {
      return {
        ...base,
        denialReason: 'inactive_membership',
      };
    }

    if (!isMembershipTemporallyValid(input.entitlement, input.now)) {
      return {
        ...base,
        denialReason: 'elapsed_access_until',
      };
    }
  }

  if (!input.actor) {
    return {
      ...base,
      denialReason: 'actor_missing',
    };
  }

  if (input.actor.accountId !== input.session.accountId) {
    return {
      ...base,
      denialReason: 'actor_account_mismatch',
    };
  }

  if (input.communityId && input.actor.communityId !== input.communityId) {
    return {
      ...base,
      denialReason: 'actor_community_mismatch',
    };
  }

  const localDenial = mapLocalEligibilityToDenial(input.localEligibility);
  if (localDenial) {
    return {
      ...base,
      denialReason: localDenial,
    };
  }

  if (!isOwner) {
    if (effectiveStatus === null || !['active', 'cancelling'].includes(effectiveStatus)) {
      return {
        ...base,
        denialReason: 'inactive_membership',
      };
    }
  }

  return {
    level: 'participant',
    canParticipate: true,
    localEligibility: input.localEligibility,
  };
}
