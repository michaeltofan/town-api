import type { Database } from '../db/client.js';
import type { CommunityRow } from '../db/schema.js';
import { findActiveCivicActorByAccountId } from '../db/repositories/confirmations.js';
import { localEligibilityAlreadyBoundError } from '../errors/app-error.js';
import { lockAccountById } from '../identity/repositories/accounts.js';
import { bindActorLocalEligibility } from '../identity/repositories/actor-link.js';
import { toIsoTimestamp } from '../lib/timestamps.js';

type Db = Database['db'];

export type LocalEligibilityBindResult = {
  community: { slug: string; displayName: string };
  verifiedAt: string;
  localEligibility: 'eligible';
};

/**
 * Set-once local eligibility bind inside a caller-provided transaction.
 * Requires the account row locked via lockAccountById before actor read.
 */
export async function bindLocalEligibilityInTransaction(
  db: Db,
  input: {
    accountId: string;
    community: CommunityRow;
    now: string;
  },
): Promise<LocalEligibilityBindResult> {
  const locked = await lockAccountById(db, input.accountId);
  if (!locked) {
    throw new Error('Local eligibility bind requires an existing account');
  }

  const actor = await findActiveCivicActorByAccountId(db, input.accountId);
  if (!actor) {
    // Invariant: session-authenticated accounts must have a linked civic actor.
    throw new Error('Linked civic actor missing for authenticated account');
  }

  if (actor.communityId === null) {
    const updated = await bindActorLocalEligibility(db, {
      actorId: actor.id,
      communityId: input.community.id,
      verifiedAt: input.now,
      updatedAt: input.now,
    });
    const verifiedAt = updated.localEligibilityVerifiedAt;
    if (verifiedAt === null) {
      throw new Error('Failed to persist local eligibility verified_at');
    }
    return {
      community: {
        slug: input.community.slug,
        displayName: input.community.displayName,
      },
      verifiedAt: toIsoTimestamp(verifiedAt),
      localEligibility: 'eligible',
    };
  }

  if (actor.communityId === input.community.id) {
    const verifiedAt = actor.localEligibilityVerifiedAt;
    if (verifiedAt === null) {
      throw new Error('Local eligibility binding missing verified_at for bound community');
    }
    return {
      community: {
        slug: input.community.slug,
        displayName: input.community.displayName,
      },
      verifiedAt: toIsoTimestamp(verifiedAt),
      localEligibility: 'eligible',
    };
  }

  throw localEligibilityAlreadyBoundError();
}
