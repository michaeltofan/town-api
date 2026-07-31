/**
 * Community choice + personal self-declaration (commitment) for Membership V1.
 *
 * This is NOT technical location/residence verification, GPS attestation, or
 * local eligibility. Do not write local_eligibility_verified_at for this path.
 */

export const COMMUNITY_COMMITMENT_VERSION = 'community-commitment-v1' as const;

export type CommunityCommitmentActorView = {
  communityId: string | null;
  communityCommitmentAcceptedAt: string | null;
  communityCommitmentVersion: string | null;
};

export function hasValidCommunityCommitment(
  actor:
    | (Partial<CommunityCommitmentActorView> & {
        communityId?: string | null;
      })
    | null
    | undefined,
): boolean {
  if (!actor) {
    return false;
  }
  return (
    actor.communityId != null &&
    actor.communityCommitmentAcceptedAt != null &&
    actor.communityCommitmentVersion === COMMUNITY_COMMITMENT_VERSION
  );
}
