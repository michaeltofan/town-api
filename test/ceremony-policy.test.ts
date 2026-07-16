import { describe, expect, it } from 'vitest';
import {
  SETUP_GRANT_TTL_MINUTES,
  SESSION_ABSOLUTE_TIMEOUT_HOURS,
  SESSION_IDLE_TIMEOUT_MINUTES,
  SENSITIVE_REAUTH_FRESHNESS_MINUTES,
  addHours,
  addMinutes,
  computeAbsoluteExpiresAt,
  computeIdleExpiresAt,
  computeSetupGrantExpiresAt,
  isSensitiveOperationFresh,
} from '../src/ceremony/policy.js';

describe('ceremony time policy', () => {
  const createdAt = '2026-07-16T10:00:00.000Z';

  it('exposes approved lifetime constants', () => {
    expect(SETUP_GRANT_TTL_MINUTES).toBe(15);
    expect(SESSION_IDLE_TIMEOUT_MINUTES).toBe(60);
    expect(SESSION_ABSOLUTE_TIMEOUT_HOURS).toBe(24);
    expect(SENSITIVE_REAUTH_FRESHNESS_MINUTES).toBe(10);
  });

  it('computes setup grant, idle, and absolute windows', () => {
    expect(computeSetupGrantExpiresAt(createdAt)).toBe(addMinutes(createdAt, 15));
    expect(computeAbsoluteExpiresAt(createdAt)).toBe(addHours(createdAt, 24));
    const absolute = computeAbsoluteExpiresAt(createdAt);
    expect(computeIdleExpiresAt(createdAt, absolute)).toBe(addMinutes(createdAt, 60));
  });

  it('never lets idle expiry exceed absolute expiry', () => {
    const absolute = addMinutes(createdAt, 30);
    expect(computeIdleExpiresAt(createdAt, absolute)).toBe(absolute);
  });

  it('evaluates sensitive-operation freshness against 10 minutes', () => {
    const authenticatedAt = '2026-07-16T10:00:00.000Z';
    expect(isSensitiveOperationFresh(authenticatedAt, '2026-07-16T10:10:00.000Z')).toBe(true);
    expect(isSensitiveOperationFresh(authenticatedAt, '2026-07-16T10:10:00.001Z')).toBe(false);
  });
});
