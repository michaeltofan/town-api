export type MembershipTransitionResultKind = 'applied' | 'replayed' | 'rejected' | 'stale';
export type MembershipEventType = 'activate' | 'schedule_cancellation' | 'expire' | 'reactivate';
export type AccessUntilCategory = 'null' | 'future' | 'present_or_past';
export type ParticipationDenialReason =
  | 'no_session'
  | 'inactive_account'
  | 'no_entitlement'
  | 'inactive_membership'
  | 'expired_membership'
  | 'elapsed_access_until'
  | 'local_not_verified'
  | 'local_expired'
  | 'local_mismatched_community'
  | 'local_unavailable'
  | 'actor_missing'
  | 'actor_account_mismatch'
  | 'actor_community_mismatch'
  | 'community_mismatch';

export type CivicAccessEvaluation = {
  level: import('../db/schema.js').CivicAccessLevel;
  canParticipate: boolean;
  localEligibility: import('../db/schema.js').LocalParticipationEligibility;
  denialReason?: ParticipationDenialReason;
};

export type AccountMembershipView = {
  membership: {
    status: import('../db/schema.js').MembershipStatus;
    accessUntil: string | null;
    cancelAtPeriodEnd: boolean;
  };
  access: {
    level: import('../db/schema.js').CivicAccessLevel;
    canParticipate: boolean;
    localEligibility: import('../db/schema.js').LocalParticipationEligibility;
  };
};
