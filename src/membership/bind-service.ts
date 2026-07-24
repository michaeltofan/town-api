import type { Database } from '../db/client.js';
import type { CommunityRow } from '../db/schema.js';
import { findActiveCivicActorByAccountId } from '../db/repositories/confirmations.js';
import { localEligibilityAlreadyBoundError } from '../errors/app-error.js';
import {
  accountNotFoundError,
  civicActorNotLinkedError,
  localEligibilityBindingIncompleteError,
  localEligibilityPersistFailedError,
} from './errors.js';
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
    throw accountNotFoundError();
  }

  const actor = await findActiveCivicActorByAccountId(db, input.accountId);
  if (!actor) {
    // Invariant: session-authenticated accounts must have a linked civic actor.
    throw civicActorNotLinkedError();
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
      throw localEligibilityPersistFailedError();
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
      throw localEligibilityBindingIncompleteError();
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
