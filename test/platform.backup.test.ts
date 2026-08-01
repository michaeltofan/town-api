import { describe, expect, it } from 'vitest';
import type { Env } from '../src/config/env.js';
import type { PlatformBackupVerificationRow } from '../src/db/schema.js';
import {
  assessBackupComponent,
  readPlatformBackupConfig,
  sanitizeBackupNote,
} from '../src/platform/services/backup.js';

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ENV: 'test',
    DATABASE_BACKUP_PROVIDER: 'none',
    DATABASE_BACKUP_PITR_ENABLED: false,
    DATABASE_BACKUP_VERIFY_MAX_AGE_DAYS: 30,
    ...overrides,
  } as Env;
}

function verification(
  overrides: Partial<PlatformBackupVerificationRow> = {},
): PlatformBackupVerificationRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    verifiedAt: '2026-08-01T12:00:00.000Z',
    verifiedByAccountId: '22222222-2222-4222-8222-222222222222',
    provider: 'railway_postgres_pitr',
    pitrEnabled: true,
    retentionDays: 7,
    note: null,
    environment: 'staging',
    commitSha: 'abc',
    ...overrides,
  };
}

describe('platform backup attestation', () => {
  it('disables backup in test when PITR is off', () => {
    expect(
      assessBackupComponent({
        env: baseEnv(),
        latestVerification: null,
        nowIso: '2026-08-01T12:00:00.000Z',
      }),
    ).toEqual({ status: 'disabled', detail: 'backup_disabled' });
  });

  it('marks staging misconfigured without PITR config', () => {
    expect(
      assessBackupComponent({
        env: baseEnv({ APP_ENV: 'staging' }),
        latestVerification: null,
        nowIso: '2026-08-01T12:00:00.000Z',
      }),
    ).toEqual({ status: 'misconfigured', detail: 'pitr_not_configured' });
  });

  it('requires retention and a fresh verification for ok', () => {
    const env = baseEnv({
      APP_ENV: 'staging',
      DATABASE_BACKUP_PROVIDER: 'railway_postgres_pitr',
      DATABASE_BACKUP_PITR_ENABLED: true,
      DATABASE_BACKUP_RETENTION_DAYS: 7,
      DATABASE_BACKUP_VERIFY_MAX_AGE_DAYS: 30,
    });
    expect(readPlatformBackupConfig(env).automated).toBe(true);
    expect(
      assessBackupComponent({
        env,
        latestVerification: null,
        nowIso: '2026-08-01T12:00:00.000Z',
      }).status,
    ).toBe('degraded');
    expect(
      assessBackupComponent({
        env,
        latestVerification: verification(),
        nowIso: '2026-08-01T12:00:00.000Z',
      }),
    ).toEqual({ status: 'ok', detail: 'railway_pitr;retention_days=7' });
    expect(
      assessBackupComponent({
        env,
        latestVerification: verification({ verifiedAt: '2026-06-01T12:00:00.000Z' }),
        nowIso: '2026-08-01T12:00:00.000Z',
      }).detail,
    ).toMatch(/^verification_stale/);
  });

  it('sanitizes backup notes', () => {
    expect(sanitizeBackupNote('Railway PITR confirmed in dashboard')).toBe(
      'Railway PITR confirmed in dashboard',
    );
    expect(sanitizeBackupNote('token=abc')).toBeNull();
  });
});
