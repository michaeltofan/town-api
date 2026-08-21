import { describe, expect, it } from 'vitest';
import type { MembershipEntitlementRow } from '../src/db/schema.js';
import {
  buildMadridPilotSelfEnrollIdempotencyKey,
  computeMadridPilotAccessUntil,
  isMadridPilotCommunitySlug,
  MADRID_PILOT_ACCESS_DAYS,
  MADRID_PILOT_COHORT,
  MADRID_PILOT_COMMUNITY_SLUG,
  shouldGrantMadridPilotAccess,
} from '../src/membership/madrid-pilot-access.js';

const NOW = '2026-08-21T10:00:00.000Z';

function makeEntitlement(
  overrides: Partial<MembershipEntitlementRow> = {},
): MembershipEntitlementRow {
  return {
    id: '30000000-0000-4000-8000-000000000001',
    accountId: '10000000-0000-4000-8000-000000000001',
    status: 'inactive',
    accessUntil: null,
    cancelAtPeriodEnd: false,
    source: 'admin',
    sourceCustomerId: null,
    sourceSubscriptionId: null,
    activatedAt: null,
    cancellationRequestedAt: null,
    expiredAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

describe('madrid-pilot-access helpers', () => {
  it('recognizes only the canonical madrid-es community slug', () => {
    expect(MADRID_PILOT_COMMUNITY_SLUG).toBe('madrid-es');
    expect(MADRID_PILOT_COHORT).toBe('madrid_pilot');
    expect(MADRID_PILOT_ACCESS_DAYS).toBe(90);
    expect(isMadridPilotCommunitySlug('madrid-es')).toBe(true);
    expect(isMadridPilotCommunitySlug('munich-de')).toBe(false);
    expect(isMadridPilotCommunitySlug('milano-it')).toBe(false);
    expect(isMadridPilotCommunitySlug('')).toBe(false);
  });

  it('computes accessUntil as now + 90 days in UTC', () => {
    expect(computeMadridPilotAccessUntil(NOW)).toBe('2026-11-19T10:00:00.000Z');
    expect(computeMadridPilotAccessUntil('2026-01-01T00:00:00.000Z')).toBe(
      '2026-04-01T00:00:00.000Z',
    );
  });

  it('builds a stable self-enroll idempotency key from account + accessUntil', () => {
    const accessUntil = computeMadridPilotAccessUntil(NOW);
    expect(buildMadridPilotSelfEnrollIdempotencyKey('acct-1', accessUntil)).toBe(
      `madrid-pilot-self-enroll:acct-1:${accessUntil}`,
    );
  });

  it('allows grant only when no entitlement or local inactive/expired', () => {
    expect(shouldGrantMadridPilotAccess(null)).toBe(true);
    expect(shouldGrantMadridPilotAccess(makeEntitlement({ status: 'inactive' }))).toBe(true);
    expect(
      shouldGrantMadridPilotAccess(
        makeEntitlement({
          status: 'expired',
          accessUntil: '2026-01-01T00:00:00.000Z',
          expiredAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    ).toBe(true);

    expect(shouldGrantMadridPilotAccess(makeEntitlement({ status: 'active' }))).toBe(false);
    expect(shouldGrantMadridPilotAccess(makeEntitlement({ status: 'cancelling' }))).toBe(false);
    expect(shouldGrantMadridPilotAccess(makeEntitlement({ status: 'suspended' }))).toBe(false);
    expect(shouldGrantMadridPilotAccess(makeEntitlement({ status: 'paid_pending_binding' }))).toBe(
      false,
    );

    // Provider-managed entitlements stay fail-closed (no admin overwrite).
    expect(
      shouldGrantMadridPilotAccess(
        makeEntitlement({ status: 'expired', source: 'stripe', accessUntil: NOW }),
      ),
    ).toBe(false);
    expect(
      shouldGrantMadridPilotAccess(makeEntitlement({ status: 'inactive', source: 'google_play' })),
    ).toBe(false);
  });
});
