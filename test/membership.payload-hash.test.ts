import { describe, expect, it } from 'vitest';
import {
  hashMembershipTransitionPayload,
  type MembershipTransitionPayloadInput,
} from '../src/membership/payload-hash.js';

const base: MembershipTransitionPayloadInput = {
  source: 'test_fixture',
  sourceEventId: 'evt_1',
  eventType: 'activate',
  accountId: '10000000-0000-4000-8000-000000000001',
  effectiveAt: '2026-07-17T00:00:00.000Z',
  accessUntil: '2026-08-17T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  sourceCustomerId: 'cus_test',
  sourceSubscriptionId: 'sub_test',
};

describe('hashMembershipTransitionPayload', () => {
  it('is deterministic across identical inputs', () => {
    expect(hashMembershipTransitionPayload(base)).toBe(hashMembershipTransitionPayload(base));
  });

  it('produces a 64-character sha256 hex digest', () => {
    const hash = hashMembershipTransitionPayload(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any canonical field changes', () => {
    const original = hashMembershipTransitionPayload(base);
    expect(hashMembershipTransitionPayload({ ...base, source: 'stripe' })).not.toBe(original);
    expect(hashMembershipTransitionPayload({ ...base, sourceEventId: 'evt_2' })).not.toBe(original);
    expect(hashMembershipTransitionPayload({ ...base, eventType: 'expire' })).not.toBe(original);
    expect(
      hashMembershipTransitionPayload({
        ...base,
        accountId: '10000000-0000-4000-8000-000000000002',
      }),
    ).not.toBe(original);
    expect(
      hashMembershipTransitionPayload({ ...base, effectiveAt: '2026-07-18T00:00:00.000Z' }),
    ).not.toBe(original);
    expect(
      hashMembershipTransitionPayload({ ...base, accessUntil: '2026-09-17T00:00:00.000Z' }),
    ).not.toBe(original);
    expect(hashMembershipTransitionPayload({ ...base, cancelAtPeriodEnd: true })).not.toBe(
      original,
    );
    expect(hashMembershipTransitionPayload({ ...base, sourceCustomerId: 'cus_other' })).not.toBe(
      original,
    );
    expect(
      hashMembershipTransitionPayload({ ...base, sourceSubscriptionId: 'sub_other' }),
    ).not.toBe(original);
  });

  it('treats undefined fields as omitted rather than null', () => {
    const withOptional = hashMembershipTransitionPayload({
      ...base,
      sourceCustomerId: 'cus_present',
    });
    const withoutOptional = hashMembershipTransitionPayload({
      source: 'test_fixture',
      sourceEventId: 'evt_1',
      eventType: 'activate',
      accountId: '10000000-0000-4000-8000-000000000001',
      effectiveAt: '2026-07-17T00:00:00.000Z',
      accessUntil: '2026-08-17T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      sourceSubscriptionId: 'sub_test',
    });
    expect(withOptional).not.toBe(withoutOptional);
  });

  it('does not include any secret, session, or email metadata in the digest', () => {
    // Extra fields on the input object must not influence the digest since the hash only reads
    // canonical PAYLOAD_KEY_ORDER keys.
    const withUnknownField = hashMembershipTransitionPayload({
      ...base,
    });
    const withExtras = hashMembershipTransitionPayload(
      Object.assign({}, base, {
        email: 'user@example.com',
        sessionToken: 'secret',
        ipAddress: '127.0.0.1',
      }),
    );
    expect(withUnknownField).toBe(hashMembershipTransitionPayload(base));
    expect(withExtras).toBe(hashMembershipTransitionPayload(base));
  });
});
