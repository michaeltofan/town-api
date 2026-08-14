import { describe, expect, it } from 'vitest';
import {
  deriveCapacityDrillSessionToken,
  requireCapacityDrillAuthSecret,
} from '../src/platform/capacity-drill/session-tokens.js';

const SECRET = 'capacity-drill-test-secret-32-characters-minimum';

describe('capacity drill session boundary', () => {
  it('accepts the dedicated secret only in the capacity environment', () => {
    expect(
      requireCapacityDrillAuthSecret({ environmentName: 'capacity', secret: SECRET }),
    ).toBe(SECRET);

    for (const environmentName of ['production', 'staging', 'prod', undefined]) {
      expect(() => requireCapacityDrillAuthSecret({ environmentName, secret: SECRET })).toThrow(
        "Capacity drill sessions are forbidden outside 'capacity'",
      );
    }
  });

  it('rejects missing and short secrets', () => {
    expect(() =>
      requireCapacityDrillAuthSecret({ environmentName: 'capacity', secret: undefined }),
    ).toThrow('CAPACITY_DRILL_AUTH_SECRET');
    expect(() =>
      requireCapacityDrillAuthSecret({ environmentName: 'capacity', secret: 'too-short' }),
    ).toThrow('CAPACITY_DRILL_AUTH_SECRET');
  });

  it('derives stable account-bound tokens without exposing the secret', () => {
    const first = deriveCapacityDrillSessionToken({ secret: SECRET, accountId: 'account-a' });
    const again = deriveCapacityDrillSessionToken({ secret: SECRET, accountId: 'account-a' });
    const second = deriveCapacityDrillSessionToken({ secret: SECRET, accountId: 'account-b' });

    expect(first).toBe(again);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain(SECRET);
  });
});
