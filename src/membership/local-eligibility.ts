import type { LocalParticipationEligibility } from '../db/schema.js';

export type LocalParticipationEligibilityResolver = (input: {
  accountId: string;
  actorId: string;
  communityId: string;
}) => Promise<LocalParticipationEligibility> | LocalParticipationEligibility;

export const DefaultFailClosedLocalEligibilityResolver: LocalParticipationEligibilityResolver =
  () => 'unavailable';

/** Test-only resolver that always grants local eligibility. */
export function createEligibleTestResolver(): LocalParticipationEligibilityResolver {
  return () => 'eligible';
}

export function createDefaultLocalEligibilityResolver(input: {
  nodeEnv?: string;
}): LocalParticipationEligibilityResolver {
  const nodeEnv = input.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production' || nodeEnv === 'test') {
    return DefaultFailClosedLocalEligibilityResolver;
  }
  return DefaultFailClosedLocalEligibilityResolver;
}
