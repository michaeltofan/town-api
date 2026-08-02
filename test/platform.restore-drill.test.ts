import { describe, expect, it } from 'vitest';
import type { Env } from '../src/config/env.js';
import type { PlatformRestoreDrillAttestationRow } from '../src/db/schema.js';
import {
  assessRestoreComponent,
  readPlatformRestoreDrillConfig,
  sanitizeRestoreDrillNote,
} from '../src/platform/services/restore-drill.js';

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ENV: 'test',
    DATABASE_BACKUP_PROVIDER: 'none',
    DATABASE_BACKUP_PITR_ENABLED: false,
    DATABASE_BACKUP_VERIFY_MAX_AGE_DAYS: 30,
    DATABASE_RESTORE_DRILL_MAX_AGE_DAYS: 90,
    ...overrides,
  } as Env;
}

function attestation(
  overrides: Partial<PlatformRestoreDrillAttestationRow> = {},
): PlatformRestoreDrillAttestationRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    drilledAt: '2026-08-01T12:00:00.000Z',
    drilledByAccountId: '22222222-2222-4222-8222-222222222222',
    method: 'railway_pitr_disposable_clone',
    outcome: 'passed',
    restorePointAt: null,
    note: null,
    environment: 'staging',
    commitSha: 'abc',
    ...overrides,
  };
}

describe('platform restore drill attestation', () => {
  it('disables restore drill in test when PITR backup is off', () => {
    expect(
      assessRestoreComponent({
        env: baseEnv(),
        latestAttestation: null,
        nowIso: '2026-08-01T12:00:00.000Z',
      }),
    ).toEqual({ status: 'disabled', detail: 'restore_drill_disabled' });
  });

  it('marks staging misconfigured without automated PITR backup', () => {
    expect(
      assessRestoreComponent({
        env: baseEnv({ APP_ENV: 'staging' }),
        latestAttestation: null,
        nowIso: '2026-08-01T12:00:00.000Z',
      }),
    ).toEqual({ status: 'misconfigured', detail: 'backup_pitr_required' });
  });

  it('requires a fresh passed drill for ok', () => {
    const env = baseEnv({
      APP_ENV: 'staging',
      DATABASE_BACKUP_PROVIDER: 'railway_postgres_pitr',
      DATABASE_BACKUP_PITR_ENABLED: true,
      DATABASE_BACKUP_RETENTION_DAYS: 7,
      DATABASE_RESTORE_DRILL_MAX_AGE_DAYS: 90,
    });
    expect(readPlatformRestoreDrillConfig(env).maxAgeDays).toBe(90);
    expect(
      assessRestoreComponent({
        env,
        latestAttestation: null,
        nowIso: '2026-08-01T12:00:00.000Z',
      }).status,
    ).toBe('degraded');
    expect(
      assessRestoreComponent({
        env,
        latestAttestation: attestation({ outcome: 'failed' }),
        nowIso: '2026-08-01T12:00:00.000Z',
      }),
    ).toEqual({ status: 'fail', detail: 'latest_drill_failed' });
    expect(
      assessRestoreComponent({
        env,
        latestAttestation: attestation(),
        nowIso: '2026-08-01T12:00:00.000Z',
      }),
    ).toEqual({
      status: 'ok',
      detail: 'drill_passed;method=railway_pitr_disposable_clone',
    });
    expect(
      assessRestoreComponent({
        env,
        latestAttestation: attestation({ drilledAt: '2026-01-01T12:00:00.000Z' }),
        nowIso: '2026-08-01T12:00:00.000Z',
      }).detail,
    ).toMatch(/^drill_stale/);
  });

  it('sanitizes restore drill notes', () => {
    expect(sanitizeRestoreDrillNote('Disposable clone restore drill passed')).toBe(
      'Disposable clone restore drill passed',
    );
    expect(sanitizeRestoreDrillNote('password=secret')).toBeNull();
  });
});
