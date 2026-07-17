import { describe, expect, it } from 'vitest';
import { createPasskeyAuthenticationEnv } from './helpers/passkey-authentication.js';
import { requirePasskeyManagementConfig } from '../src/ceremony/passkey-management/config.js';
import { normalizeLabel } from '../src/ceremony/passkey-management/labels.js';
import {
  computeFreshUntil,
  isSessionFreshForManagement,
} from '../src/ceremony/passkey-management/service.js';

describe('passkey management config and policy helpers', () => {
  it('resolves management config from authentication + webauthn env', () => {
    const env = createPasskeyAuthenticationEnv();
    const config = requirePasskeyManagementConfig(env);
    expect(config.enabled).toBe(true);
    expect(config.rpId).toBeTruthy();
    expect(config.challengeHashKey.length).toBeGreaterThanOrEqual(32);
    expect(config.webSessionCookieName).toBeTruthy();
  });

  it('normalizes labels and rejects control characters', () => {
    expect(normalizeLabel('  Hello  ')).toBe('Hello');
    expect(normalizeLabel('')).toBeNull();
    expect(normalizeLabel('   ')).toBeNull();
    expect(() => normalizeLabel('bad\0label')).toThrow();
    expect(() => normalizeLabel('a'.repeat(65))).toThrow();
    expect(normalizeLabel('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('evaluates freshness from fresh_authenticated_at', () => {
    const now = '2026-07-17T12:00:00.000Z';
    const freshSession = {
      freshAuthenticatedAt: '2026-07-17T11:55:00.000Z',
    } as Parameters<typeof isSessionFreshForManagement>[0];
    const staleSession = {
      freshAuthenticatedAt: '2026-07-17T11:40:00.000Z',
    } as Parameters<typeof isSessionFreshForManagement>[0];
    const missing = {
      freshAuthenticatedAt: null,
    } as Parameters<typeof isSessionFreshForManagement>[0];

    expect(isSessionFreshForManagement(freshSession, now)).toBe(true);
    expect(isSessionFreshForManagement(staleSession, now)).toBe(false);
    expect(isSessionFreshForManagement(missing, now)).toBe(false);
    expect(computeFreshUntil('2026-07-17T11:55:00.000Z')).toBe('2026-07-17T12:05:00.000Z');
  });
});
