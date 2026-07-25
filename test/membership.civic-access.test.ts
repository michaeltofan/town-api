import { describe, expect, it } from 'vitest';
import type {
  AccountRow,
  ActorRow,
  LocalParticipationEligibility,
  MembershipEntitlementRow,
} from '../src/db/schema.js';
import {
  evaluateCivicAccess,
  resolveEffectiveMembershipStatus,
} from '../src/membership/civic-access.js';
import { createDefaultLocalEligibilityResolver } from '../src/membership/local-eligibility.js';

const NOW = '2026-07-17T12:00:00.000Z';
const ACCOUNT_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-8000-000000000099';
const COMMUNITY_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_COMMUNITY_ID = '00000000-0000-4000-8000-000000000002';

function makeAccount(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: ACCOUNT_ID,
    status: 'active',
    webauthnUserHandle: null,
    accountReadyAt: NOW,
    recoveryCompletedAt: null,
    suspendedAt: null,
    closedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
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

describe('resolveEffectiveMembershipStatus', () => {
  it('returns paid_pending_binding unchanged when access_until is future', () => {
    expect(
      resolveEffectiveMembershipStatus(
        makeEntitlement({
          status: 'paid_pending_binding',
          activatedAt: null,
          source: 'google_play',
        }),
        NOW,
      ),
    ).toBe('paid_pending_binding');
  });

  it('returns inactive when entitlement is missing', () => {
    expect(resolveEffectiveMembershipStatus(null, NOW)).toBe('inactive');
  });
  it('returns expired when access_until has elapsed', () => {
    expect(
      resolveEffectiveMembershipStatus(
        makeEntitlement({ status: 'active', accessUntil: '2026-07-01T00:00:00.000Z' }),
        NOW,
      ),
    ).toBe('expired');
  });
  it('treats now == access_until as expired (inclusive elapsed)', () => {
    expect(
      resolveEffectiveMembershipStatus(
        makeEntitlement({ status: 'active', accessUntil: NOW }),
        NOW,
      ),
    ).toBe('expired');
  });
  it('preserves stored status when access_until is future', () => {
    expect(
      resolveEffectiveMembershipStatus(
        makeEntitlement({ status: 'cancelling', cancelAtPeriodEnd: true }),
        NOW,
      ),
    ).toBe('cancelling');
  });
});

describe('evaluateCivicAccess', () => {
  const eligibleLocal: LocalParticipationEligibility = 'eligible';

  it('returns visitor when session is absent', () => {
    const result = evaluateCivicAccess({
      session: null,
      account: null,
      entitlement: null,
      actor: null,
      localEligibility: 'unavailable',
      now: NOW,
    });
    expect(result.level).toBe('visitor');
    expect(result.canParticipate).toBe(false);
  });

  it('returns read_only when session exists but no entitlement', () => {
    const result = evaluateCivicAccess({
      session: { accountId: ACCOUNT_ID },
      account: makeAccount(),
      entitlement: null,
      actor: makeActor(),
      communityId: COMMUNITY_ID,
      localEligibility: eligibleLocal,
      now: NOW,
    });
    expect(result.level).toBe('read_only');
    expect(result.canParticipate).toBe(false);
    expect(result.denialReason).toBe('no_entitlement');
  });

  it('returns read_only with expired_membership when access_until has elapsed', () => {
    const result = evaluateCivicAccess({
      session: { accountId: ACCOUNT_ID },
      account: makeAccount(),
      entitlement: makeEntitlement({ accessUntil: '2026-07-01T00:00:00.000Z' }),
      actor: makeActor(),
      communityId: COMMUNITY_ID,
      localEligibility: eligibleLocal,
      now: NOW,
    });
    expect(result.level).toBe('read_only');
    expect(result.denialReason).toBe('expired_membership');
  });

  it('denies participation for paid_pending_binding even with eligible local actor', () => {
    const result = evaluateCivicAccess({
      session: { accountId: ACCOUNT_ID },
      account: makeAccount(),
      entitlement: makeEntitlement({
        status: 'paid_pending_binding',
        activatedAt: null,
        source: 'google_play',
      }),
      actor: makeActor({ localEligibilityVerifiedAt: NOW }),
      communityId: COMMUNITY_ID,
      localEligibility: eligibleLocal,
      now: NOW,
    });
    expect(result.level).toBe('read_only');
    expect(result.canParticipate).toBe(false);
    expect(result.denialReason).toBe('inactive_membership');
  });

  it('boundary now == access_until is expired', () => {
    const result = evaluateCivicAccess({
      session: { accountId: ACCOUNT_ID },
      account: makeAccount(),
      entitlement: makeEntitlement({ accessUntil: NOW }),
      actor: makeActor(),
      communityId: COMMUNITY_ID,
      localEligibility: eligibleLocal,
      now: NOW,
    });
    expect(result.denialReason).toBe('expired_membership');
  });

  it('rejects when local eligibility is unavailable (fail-closed)', () => {
    const result = evaluateCivicAccess({
      session: { accountId: ACCOUNT_ID },
      account: makeAccount(),
      entitlement: makeEntitlement(),
      actor: makeActor(),
      communityId: COMMUNITY_ID,
      localEligibility: 'unavailable',
      now: NOW,
    });
    expect(result.level).toBe('read_only');
    expect(result.denialReason).toBe('local_unavailable');
  });

  it('rejects when actor community does not match the request community', () => {
    const result = evaluateCivicAccess({
      session: { accountId: ACCOUNT_ID },
      account: makeAccount(),
      entitlement: makeEntitlement(),
      actor: makeActor({ communityId: OTHER_COMMUNITY_ID }),
      communityId: COMMUNITY_ID,
      localEligibility: eligibleLocal,
      now: NOW,
    });
    expect(result.denialReason).toBe('actor_community_mismatch');
  });

  it('rejects when session account does not match linked account', () => {
    const result = evaluateCivicAccess({
      session: { accountId: OTHER_ACCOUNT_ID },
      account: makeAccount(),
      entitlement: makeEntitlement(),
      actor: makeActor(),
      communityId: COMMUNITY_ID,
      localEligibility: eligibleLocal,
      now: NOW,
    });
    expect(result.denialReason).toBe('inactive_account');
  });

  it('grants participant on active membership + eligible local + matching actor', () => {
    const result = evaluateCivicAccess({
      session: { accountId: ACCOUNT_ID },
      account: makeAccount(),
      entitlement: makeEntitlement(),
      actor: makeActor(),
      communityId: COMMUNITY_ID,
      localEligibility: eligibleLocal,
      now: NOW,
    });
    expect(result.level).toBe('participant');
    expect(result.canParticipate).toBe(true);
    expect(result.denialReason).toBeUndefined();
  });

  it('grants participant on cancelling membership while still temporally valid', () => {
    const result = evaluateCivicAccess({
      session: { accountId: ACCOUNT_ID },
      account: makeAccount(),
      entitlement: makeEntitlement({
        status: 'cancelling',
        cancelAtPeriodEnd: true,
        cancellationRequestedAt: '2026-07-10T00:00:00.000Z',
      }),
      actor: makeActor(),
      communityId: COMMUNITY_ID,
      localEligibility: eligibleLocal,
      now: NOW,
    });
    expect(result.level).toBe('participant');
    expect(result.canParticipate).toBe(true);
  });
});

describe('createDefaultLocalEligibilityResolver', () => {
  const actorBound = {
    id: '20000000-0000-4000-8000-000000000001',
    communityId: COMMUNITY_ID,
    localEligibilityVerifiedAt: NOW,
  };

  it('is fail-closed when LOCAL_ELIGIBILITY_ENABLED is false', async () => {
    const resolver = createDefaultLocalEligibilityResolver({
      localEligibilityEnabled: false,
    });
    await expect(
      Promise.resolve(
        resolver({
          accountId: 'a',
          actorId: actorBound.id,
          communityId: COMMUNITY_ID,
          actor: actorBound,
        }),
      ),
    ).resolves.toBe('unavailable');
  });

  it('derives eligible when enabled and community matches with verified_at', async () => {
    const resolver = createDefaultLocalEligibilityResolver({
      localEligibilityEnabled: true,
    });
    await expect(
      Promise.resolve(
        resolver({
          accountId: ACCOUNT_ID,
          actorId: actorBound.id,
          communityId: COMMUNITY_ID,
          actor: actorBound,
        }),
      ),
    ).resolves.toBe('eligible');
  });

  it('derives not_verified when enabled and verified_at is null', async () => {
    const resolver = createDefaultLocalEligibilityResolver({
      localEligibilityEnabled: true,
    });
    await expect(
      Promise.resolve(
        resolver({
          accountId: ACCOUNT_ID,
          actorId: actorBound.id,
          communityId: COMMUNITY_ID,
          actor: { ...actorBound, localEligibilityVerifiedAt: null },
        }),
      ),
    ).resolves.toBe('not_verified');
  });

  it('derives mismatched_community when enabled and communities differ', async () => {
    const resolver = createDefaultLocalEligibilityResolver({
      localEligibilityEnabled: true,
    });
    await expect(
      Promise.resolve(
        resolver({
          accountId: ACCOUNT_ID,
          actorId: actorBound.id,
          communityId: OTHER_COMMUNITY_ID,
          actor: actorBound,
        }),
      ),
    ).resolves.toBe('mismatched_community');
  });

  it('derives not_verified when enabled and actor is null', async () => {
    const resolver = createDefaultLocalEligibilityResolver({
      localEligibilityEnabled: true,
    });
    await expect(
      Promise.resolve(
        resolver({
          accountId: ACCOUNT_ID,
          actorId: actorBound.id,
          communityId: COMMUNITY_ID,
          actor: null,
        }),
      ),
    ).resolves.toBe('not_verified');
  });

  it('derives not_verified when enabled and community_id is null', async () => {
    const resolver = createDefaultLocalEligibilityResolver({
      localEligibilityEnabled: true,
    });
    await expect(
      Promise.resolve(
        resolver({
          accountId: ACCOUNT_ID,
          actorId: actorBound.id,
          communityId: COMMUNITY_ID,
          actor: { ...actorBound, communityId: null, localEligibilityVerifiedAt: null },
        }),
      ),
    ).resolves.toBe('not_verified');
  });

  it('never returns expired when enabled', async () => {
    const resolver = createDefaultLocalEligibilityResolver({
      localEligibilityEnabled: true,
    });
    const results = await Promise.all([
      Promise.resolve(
        resolver({
          accountId: ACCOUNT_ID,
          actorId: actorBound.id,
          communityId: COMMUNITY_ID,
          actor: null,
        }),
      ),
      Promise.resolve(
        resolver({
          accountId: ACCOUNT_ID,
          actorId: actorBound.id,
          communityId: COMMUNITY_ID,
          actor: { ...actorBound, communityId: null, localEligibilityVerifiedAt: null },
        }),
      ),
      Promise.resolve(
        resolver({
          accountId: ACCOUNT_ID,
          actorId: actorBound.id,
          communityId: OTHER_COMMUNITY_ID,
          actor: actorBound,
        }),
      ),
      Promise.resolve(
        resolver({
          accountId: ACCOUNT_ID,
          actorId: actorBound.id,
          communityId: COMMUNITY_ID,
          actor: actorBound,
        }),
      ),
    ]);
    expect(results).not.toContain('expired');
  });
});
