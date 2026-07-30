import type {
  AccountRow,
  ActorRow,
  CivicAccessLevel,
  LocalParticipationEligibility,
  MembershipEntitlementRow,
  MembershipStatus,
} from '../db/schema.js';
import { hasValidCommunityCommitment } from './community-commitment.js';
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

/**
 * Owner accounts (`isOwner === true`) bypass membership/payment entitlement checks
 * only. Session, active-account, actor, community, and community-commitment gates are
 * unchanged. Owner access is the same `participant` level granted for active/cancelling
 * membership — nothing beyond that.
 *
 * Membership V1 participation requires paid access AND a valid recorded community
 * commitment (personal self-declaration). Technical local-eligibility / GPS
 * verification is not a participation gate for this V1 path.
 */
export function evaluateCivicAccess(input: {
  session: null | { accountId: string };
  account: null | Pick<AccountRow, 'id' | 'status' | 'isOwner'>;
  entitlement: null | MembershipEntitlementRow;
  actor: null | (Pick<ActorRow, 'id' | 'accountId' | 'communityId' | 'kind' | 'status'> & {
    communityCommitmentAcceptedAt?: string | null;
    communityCommitmentVersion?: string | null;
  });
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

    if (effectiveStatus === 'suspended') {
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

    if (!['active', 'cancelling'].includes(effectiveStatus)) {
      return {
        ...base,
        denialReason: 'inactive_membership',
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

  // Personal community commitment (self-declaration) — not technical verification.
  // Existing community_id without explicit acceptance must fail closed.
  if (!hasValidCommunityCommitment(input.actor)) {
    return {
      ...base,
      denialReason: 'community_commitment_missing',
    };
  }

  return {
    level: 'participant',
    canParticipate: true,
    // Echo resolver output for honesty; never claim technical verification from commitment.
    localEligibility: input.localEligibility,
  };
}
