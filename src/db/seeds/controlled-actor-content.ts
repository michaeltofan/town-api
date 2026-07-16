import { FOUNDATION_COMMUNITY_IDS } from './foundation-content.js';

/**
 * Canonical controlled test actor for Signal Confirmation Foundation V1.
 *
 * Exactly one actor. Fixed UUID and timestamps. Not a public user account.
 * Seed execution must not use Date.now() or random UUID generation.
 */

export type CanonicalControlledActor = {
  id: string;
  kind: 'controlled_test';
  status: 'active';
  displayLabel: string;
  communityId: string;
  createdAt: string;
  updatedAt: string;
};

export const CONTROLLED_TEST_ACTOR_ID = '00000000-0000-4000-8000-000000000301';

export const CONTROLLED_TEST_ACTOR = {
  id: CONTROLLED_TEST_ACTOR_ID,
  kind: 'controlled_test',
  status: 'active',
  displayLabel: 'Controlled test actor',
  communityId: FOUNDATION_COMMUNITY_IDS.milanoIt,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
} as const satisfies CanonicalControlledActor;
