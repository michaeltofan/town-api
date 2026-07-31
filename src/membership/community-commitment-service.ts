import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { actors, type CommunityRow } from '../db/schema.js';
import { findActiveCivicActorByAccountId } from '../db/repositories/confirmations.js';
import { findActiveCommunityById } from '../db/repositories/communities.js';
import {
  AppError,
  accountNotFoundError,
  communityCommitmentLockedError,
  communityCommitmentPersistFailedError,
} from '../errors/app-error.js';
import { lockAccountById } from '../identity/repositories/accounts.js';
import { toIsoTimestamp } from '../lib/timestamps.js';
import {
  COMMUNITY_COMMITMENT_VERSION,
  hasValidCommunityCommitment,
} from './community-commitment.js';
import { findEntitlementByAccountId } from './repositories/entitlements.js';
import { resolveEffectiveMembershipStatus } from './civic-access.js';

function civicActorNotLinkedError(): AppError {
  return new AppError(
    500,
    'CIVIC_ACTOR_NOT_LINKED',
    'Linked civic actor was not found for the account.',
  );
}

type Db = Database['db'];

export type CommunityCommitmentView = {
  status: 'none' | 'recorded';
  community: {
    slug: string;
    displayName: string;
    cityName: string;
    countryCode: string;
  } | null;
  accepted: boolean;
  acceptedAt: string | null;
  commitmentVersion: string | null;
  editable: boolean;
};

function isPaidAccessBlockingEdit(
  entitlement: Awaited<ReturnType<typeof findEntitlementByAccountId>>,
  now: string,
): boolean {
  if (!entitlement) {
    return false;
  }
  const status = resolveEffectiveMembershipStatus(entitlement, now);
  return status === 'active' || status === 'cancelling';
}

export async function getCommunityCommitmentView(
  db: Db,
  input: { accountId: string; now: string },
): Promise<CommunityCommitmentView> {
  const actor = await findActiveCivicActorByAccountId(db, input.accountId);
  const entitlement = await findEntitlementByAccountId(db, input.accountId);
  const editable = !isPaidAccessBlockingEdit(entitlement, input.now);

  if (!actor || !hasValidCommunityCommitment(actor)) {
    return {
      status: 'none',
      community: null,
      accepted: false,
      acceptedAt: null,
      commitmentVersion: null,
      editable,
    };
  }

  const community =
    actor.communityId != null ? await findActiveCommunityById(db, actor.communityId) : null;
  if (!community) {
    return {
      status: 'none',
      community: null,
      accepted: false,
      acceptedAt: null,
      commitmentVersion: null,
      editable,
    };
  }

  return {
    status: 'recorded',
    community: {
      slug: community.slug,
      displayName: community.displayName,
      cityName: community.cityName,
      countryCode: community.countryCode,
    },
    accepted: true,
    acceptedAt: actor.communityCommitmentAcceptedAt
      ? toIsoTimestamp(actor.communityCommitmentAcceptedAt)
      : null,
    commitmentVersion: actor.communityCommitmentVersion,
    editable,
  };
}

/**
 * Record an explicit community commitment for the authenticated natural person.
 * Never writes local_eligibility_verified_at. Country/city are derived from the
 * canonical community row only.
 */
export async function recordCommunityCommitmentInTransaction(
  db: Db,
  input: {
    accountId: string;
    community: CommunityRow;
    now: string;
  },
): Promise<CommunityCommitmentView> {
  const locked = await lockAccountById(db, input.accountId);
  if (!locked) {
    throw accountNotFoundError();
  }

  const actor = await findActiveCivicActorByAccountId(db, input.accountId);
  if (!actor) {
    throw civicActorNotLinkedError();
  }

  const entitlement = await findEntitlementByAccountId(db, input.accountId);
  if (isPaidAccessBlockingEdit(entitlement, input.now)) {
    // Identical re-submit of the same committed community remains idempotent.
    if (hasValidCommunityCommitment(actor) && actor.communityId === input.community.id) {
      return getCommunityCommitmentView(db, {
        accountId: input.accountId,
        now: input.now,
      });
    }
    throw communityCommitmentLockedError();
  }

  // Idempotent identical submission: keep original acceptance timestamp.
  if (hasValidCommunityCommitment(actor) && actor.communityId === input.community.id) {
    return getCommunityCommitmentView(db, {
      accountId: input.accountId,
      now: input.now,
    });
  }

  const updated = await db
    .update(actors)
    .set({
      communityId: input.community.id,
      communityCommitmentAcceptedAt: input.now,
      communityCommitmentVersion: COMMUNITY_COMMITMENT_VERSION,
      updatedAt: input.now,
      // Explicit: do not touch local_eligibility_verified_at.
    })
    .where(eq(actors.id, actor.id))
    .returning();

  const row = updated[0];
  if (!row || !hasValidCommunityCommitment(row)) {
    throw communityCommitmentPersistFailedError();
  }

  const acceptedAtRaw = row.communityCommitmentAcceptedAt;
  if (acceptedAtRaw == null) {
    throw communityCommitmentPersistFailedError();
  }

  return {
    status: 'recorded',
    community: {
      slug: input.community.slug,
      displayName: input.community.displayName,
      cityName: input.community.cityName,
      countryCode: input.community.countryCode,
    },
    accepted: true,
    acceptedAt: toIsoTimestamp(acceptedAtRaw),
    commitmentVersion: row.communityCommitmentVersion,
    editable: true,
  };
}
