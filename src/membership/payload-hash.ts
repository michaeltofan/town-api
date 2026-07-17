import { createHash } from 'node:crypto';
import type { MembershipSource, MembershipSourceEventType } from '../db/schema.js';

export type MembershipTransitionPayloadInput = {
  source: MembershipSource;
  sourceEventId: string;
  eventType: MembershipSourceEventType;
  accountId: string;
  effectiveAt: string;
  sourceCustomerId?: string | null;
  sourceSubscriptionId?: string | null;
  accessUntil?: string | null;
  cancelAtPeriodEnd?: boolean | null;
};

const PAYLOAD_KEY_ORDER = [
  'accessUntil',
  'accountId',
  'cancelAtPeriodEnd',
  'effectiveAt',
  'eventType',
  'source',
  'sourceCustomerId',
  'sourceEventId',
  'sourceSubscriptionId',
] as const satisfies readonly (keyof MembershipTransitionPayloadInput)[];

/**
 * SHA-256 hex digest of deterministic canonical JSON for normalized transition fields.
 * Never includes email, session, IP, or payment artifacts beyond reserved source ids.
 */
export function hashMembershipTransitionPayload(input: MembershipTransitionPayloadInput): string {
  const canonical: Record<string, string | boolean | null> = {};
  for (const key of PAYLOAD_KEY_ORDER) {
    const value = input[key];
    if (value !== undefined) {
      canonical[key] = value;
    }
  }
  const json = JSON.stringify(canonical);
  return createHash('sha256').update(json).digest('hex');
}
