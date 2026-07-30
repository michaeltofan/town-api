import { describe, expect, it } from 'vitest';
import type {
  AccountRow,
  ActorRow,
  MembershipEntitlementRow,
} from '../src/db/schema.js';
import { evaluateCivicAccess } from '../src/membership/civic-access.js';
import { COMMUNITY_COMMITMENT_VERSION } from '../src/membership/community-commitment.js';

const NOW = '2026-07-17T12:00:00.000Z';
const ACCOUNT_ID = '10000000-0000-4000-8000-000000000001';
const COMMUNITY_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_COMMUNITY_ID = '00000000-0000-4000-8000-000000000002';

function makeAccount(): AccountRow {
  return {
    id: ACCOUNT_ID,
    status: 'active',
    isOwner: false,
    webauthnUserHandle: null,
    accountReadyAt: NOW,
    recoveryCompletedAt: null,
    suspendedAt: null,
    closedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeActor(overrides: Partial<ActorRow> = {}): ActorRow {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    kind: 'civic',
    status: 'active',
    displayLabel: 'Civic',
    communityId: COMMUNITY_ID,
    accountId: ACCOUNT_ID,
    localEligibilityVerifiedAt: null,
    communityCommitmentAcceptedAt: NOW,
    communityCommitmentVersion: COMMUNITY_COMMITMENT_VERSION,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeEntitlement(
  overrides: Partial<MembershipEntitlementRow> = {},
): MembershipEntitlementRow {
  return {
    id: '30000000-0000-4000-8000-000000000001',
    accountId: ACCOUNT_ID,
    status: 'active',
    accessUntil: '2026-08-17T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    source: 'test_fixture',
    sourceCustomerId: null,
    sourceSubscriptionId: null,
    activatedAt: '2026-07-01T00:00:00.000Z',
    cancellationRequestedAt: null,
    expiredAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('Membership V1 participation = paid access + community commitment', () => {
  it('commitment alone cannot grant participation', () => {
    const result = evaluateCivicAccess({
      session: { accountId: ACCOUNT_ID },
      account: makeAccount(),
      entitlement: null,
      actor: makeActor(),
      communityId: COMMUNITY_ID,
      localEligibility: 'unavailable',
      now: NOW,
    });
    expect(result.canParticipate).toBe(false);
    expect(result.denialReason).toBe('no_entitlement');
  });

  it('active membership + commitment permits participation only in committed community', () => {
    const ok = evaluateCivicAccess({
      session: { accountId: ACCOUNT_ID },
      account: makeAccount(),
      entitlement: makeEntitlement(),
      actor: makeActor(),
      communityId: COMMUNITY_ID,
      localEligibility: 'unavailable',
      now: NOW,
    });
    expect(ok.canParticipate).toBe(true);

    const mismatch = evaluateCivicAccess({
      session: { accountId: ACCOUNT_ID },
      account: makeAccount(),
      entitlement: makeEntitlement(),
      actor: makeActor(),
      communityId: OTHER_COMMUNITY_ID,
      localEligibility: 'unavailable',
      now: NOW,
    });
    expect(mismatch.canParticipate).toBe(false);
    expect(mismatch.denialReason).toBe('actor_community_mismatch');
  });

  it('inactive membership cannot participate even with commitment', () => {
    const result = evaluateCivicAccess({
      session: { accountId: ACCOUNT_ID },
      account: makeAccount(),
      entitlement: makeEntitlement({ status: 'inactive', accessUntil: null, activatedAt: null }),
      actor: makeActor(),
      communityId: COMMUNITY_ID,
      localEligibility: 'unavailable',
      now: NOW,
    });
    expect(result.canParticipate).toBe(false);
  });

  it('expired membership cannot participate even with commitment', () => {
    const result = evaluateCivicAccess({
      session: { accountId: ACCOUNT_ID },
      account: makeAccount(),
      entitlement: makeEntitlement({
        status: 'expired',
        accessUntil: '2026-07-01T00:00:00.000Z',
        expiredAt: '2026-07-01T00:00:00.000Z',
      }),
      actor: makeActor(),
      communityId: COMMUNITY_ID,
      localEligibility: 'unavailable',
      now: NOW,
    });
    expect(result.canParticipate).toBe(false);
    expect(result.denialReason).toBe('expired_membership');
  });

  it('cancelling membership continues to respect access_until', () => {
    const within = evaluateCivicAccess({
      session: { accountId: ACCOUNT_ID },
      account: makeAccount(),
      entitlement: makeEntitlement({
        status: 'cancelling',
        cancelAtPeriodEnd: true,
        cancellationRequestedAt: '2026-07-10T00:00:00.000Z',
        accessUntil: '2026-08-17T00:00:00.000Z',
      }),
      actor: makeActor(),
      communityId: COMMUNITY_ID,
      localEligibility: 'unavailable',
      now: NOW,
    });
    expect(within.canParticipate).toBe(true);

    const elapsed = evaluateCivicAccess({
      session: { accountId: ACCOUNT_ID },
      account: makeAccount(),
      entitlement: makeEntitlement({
        status: 'cancelling',
        cancelAtPeriodEnd: true,
        cancellationRequestedAt: '2026-07-01T00:00:00.000Z',
        accessUntil: '2026-07-10T00:00:00.000Z',
      }),
      actor: makeActor(),
      communityId: COMMUNITY_ID,
      localEligibility: 'unavailable',
      now: NOW,
    });
    expect(elapsed.canParticipate).toBe(false);
  });
});
