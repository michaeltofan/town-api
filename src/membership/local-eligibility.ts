import type { ActorRow, LocalParticipationEligibility } from '../db/schema.js';

export type LocalEligibilityActorView = Pick<
  ActorRow,
  'id' | 'communityId' | 'localEligibilityVerifiedAt'
>;

export type LocalParticipationEligibilityResolver = (input: {
  accountId: string;
  actorId: string;
  communityId: string;
  actor: LocalEligibilityActorView | null;
}) => Promise<LocalParticipationEligibility> | LocalParticipationEligibility;

export const DefaultFailClosedLocalEligibilityResolver: LocalParticipationEligibilityResolver =
  () => 'unavailable';

/** Test-only resolver that always grants local eligibility. */
export function createEligibleTestResolver(): LocalParticipationEligibilityResolver {
  return () => 'eligible';
}

function deriveEnabledLocalEligibility(input: {
  actor: LocalEligibilityActorView | null;
  communityId: string;
}): LocalParticipationEligibility {
  const actor = input.actor;
  if (actor?.communityId == null || actor.localEligibilityVerifiedAt == null) {
    return 'not_verified';
  }
  if (actor.communityId !== input.communityId) {
    return 'mismatched_community';
  }
  return 'eligible';
}

export function createDefaultLocalEligibilityResolver(input: {
  localEligibilityEnabled: boolean;
}): LocalParticipationEligibilityResolver {
  if (!input.localEligibilityEnabled) {
    return DefaultFailClosedLocalEligibilityResolver;
  }
  return (resolveInput) =>
    deriveEnabledLocalEligibility({
      actor: resolveInput.actor,
      communityId: resolveInput.communityId,
    });
}
