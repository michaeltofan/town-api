import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import type { MembershipEntitlementRow, MembershipSource } from '../db/schema.js';
import { grantPlatformMembership } from '../platform/services/memberships.js';
import { findEntitlementByAccountId } from './repositories/entitlements.js';

type Db = Database['db'];

/** Canonical Madrid pilot community slug — only this community self-enrolls. */
export const MADRID_PILOT_COMMUNITY_SLUG = 'madrid-es' as const;

/** Pilot cohort tag written alongside the admin entitlement grant. */
export const MADRID_PILOT_COHORT = 'madrid_pilot' as const;

/** Free confirm window for Madrid pilot self-enroll (no Stripe). */
export const MADRID_PILOT_ACCESS_DAYS = 90;

export const MADRID_PILOT_GRANT_REASON =
  'Madrid pilot self-enroll free confirm (90 days, no Stripe)' as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const PROVIDER_SOURCES = new Set<MembershipSource>(['stripe', 'google_play']);

export function isMadridPilotCommunitySlug(slug: string): boolean {
  return slug === MADRID_PILOT_COMMUNITY_SLUG;
}

/**
 * Compute accessUntil = now + 90 calendar days (UTC ms arithmetic).
 * Matches the existing admin grant model (`accessUntil`, no Stripe period).
 */
export function computeMadridPilotAccessUntil(now: string): string {
  const base = new Date(now);
  if (Number.isNaN(base.getTime())) {
    throw new Error('Invalid now timestamp for Madrid pilot accessUntil');
  }
  return new Date(base.getTime() + MADRID_PILOT_ACCESS_DAYS * MS_PER_DAY).toISOString();
}

export function buildMadridPilotSelfEnrollIdempotencyKey(
  accountId: string,
  accessUntil: string,
): string {
  return `madrid-pilot-self-enroll:${accountId}:${accessUntil}`;
}

/**
 * True when an administrative grant is safe to attempt without rolling back the
 * surrounding community-commitment transaction. Fail-closed for provider-managed
 * entitlements and for non-grantable membership states.
 */
export function shouldGrantMadridPilotAccess(
  entitlement: MembershipEntitlementRow | null,
): boolean {
  if (!entitlement) {
    return true;
  }
  if (PROVIDER_SOURCES.has(entitlement.source as MembershipSource)) {
    return false;
  }
  return entitlement.status === 'inactive' || entitlement.status === 'expired';
}

export type EnsureMadridPilotAccessInput = {
  accountId: string;
  communitySlug: string;
  now: string;
  requestId: string;
  generateId?: () => string;
};

export type EnsureMadridPilotAccessResult =
  | { applied: false; reason: 'not_madrid_pilot_community' | 'grant_not_eligible' }
  | { applied: true; reason: 'granted'; accessUntil: string };

/**
 * After a recorded community commitment on `madrid-es`, grant the authenticated
 * account an admin entitlement (90 days) + `madrid_pilot` cohort via the same
 * audited `grantPlatformMembership` path used by ops. Non-Madrid is a no-op
 * (fail-closed — no simulated membership).
 */
export async function ensureMadridPilotAccessAfterCommitment(
  db: Db,
  input: EnsureMadridPilotAccessInput,
): Promise<EnsureMadridPilotAccessResult> {
  if (!isMadridPilotCommunitySlug(input.communitySlug)) {
    return { applied: false, reason: 'not_madrid_pilot_community' };
  }

  const existing = await findEntitlementByAccountId(db, input.accountId);
  if (!shouldGrantMadridPilotAccess(existing)) {
    return { applied: false, reason: 'grant_not_eligible' };
  }

  const generateId = input.generateId ?? (() => randomUUID());
  const accessUntil = computeMadridPilotAccessUntil(input.now);

  await grantPlatformMembership(db, {
    accountId: input.accountId,
    accessUntil,
    reason: MADRID_PILOT_GRANT_REASON,
    idempotencyKey: buildMadridPilotSelfEnrollIdempotencyKey(input.accountId, accessUntil),
    operatorAccountId: input.accountId,
    requestId: input.requestId,
    now: input.now,
    generateId,
    cohort: MADRID_PILOT_COHORT,
  });

  return { applied: true, reason: 'granted', accessUntil };
}
