import type { Env } from '../../config/env.js';
import type { PlatformRestoreDrillAttestationRow } from '../../db/schema.js';
import type { PlatformComponentCheck } from './status-checks.js';
import { readPlatformBackupConfig, sanitizeBackupNote } from './backup.js';

export type PlatformRestoreDrillMethod =
  'railway_pitr_disposable_clone' | 'railway_pitr_point_in_time';

export type PlatformRestoreDrillOutcome = 'passed' | 'failed';

export type PlatformRestoreDrillConfig = {
  readonly maxAgeDays: number;
  /** Restore drills are only meaningful when automated PITR backup is configured. */
  readonly requiresAutomatedBackup: boolean;
};

export const PLATFORM_RESTORE_DRILL_METHODS = [
  'railway_pitr_disposable_clone',
  'railway_pitr_point_in_time',
] as const;

export function readPlatformRestoreDrillConfig(env: Env): PlatformRestoreDrillConfig {
  return {
    maxAgeDays: env.DATABASE_RESTORE_DRILL_MAX_AGE_DAYS,
    requiresAutomatedBackup: true,
  };
}

export function sanitizeRestoreDrillNote(raw: string | undefined): string | null {
  return sanitizeBackupNote(raw);
}

export function isPlatformRestoreDrillMethod(value: string): value is PlatformRestoreDrillMethod {
  return (PLATFORM_RESTORE_DRILL_METHODS as readonly string[]).includes(value);
}

export const PLATFORM_RESTORE_DRILL_OUTCOMES = ['passed', 'failed'] as const;

export function isPlatformRestoreDrillOutcome(value: string): value is PlatformRestoreDrillOutcome {
  return (PLATFORM_RESTORE_DRILL_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Assess restore-drill freshness for Monitor.
 * Attestation only — the API never executes database restore.
 */
export function assessRestoreComponent(input: {
  env: Env;
  latestAttestation: PlatformRestoreDrillAttestationRow | null;
  nowIso: string;
}): PlatformComponentCheck {
  const backup = readPlatformBackupConfig(input.env);
  const drill = readPlatformRestoreDrillConfig(input.env);

  if (input.env.APP_ENV === 'development' || input.env.APP_ENV === 'test') {
    if (!backup.automated) {
      return { status: 'disabled', detail: 'restore_drill_disabled' };
    }
  }

  if (!backup.automated) {
    return { status: 'misconfigured', detail: 'backup_pitr_required' };
  }

  if (!input.latestAttestation) {
    return {
      status: 'degraded',
      detail: `drill_missing;max_age_days=${String(drill.maxAgeDays)}`,
    };
  }

  if (input.latestAttestation.outcome === 'failed') {
    return { status: 'fail', detail: 'latest_drill_failed' };
  }

  const drilledMs = Date.parse(input.latestAttestation.drilledAt);
  const nowMs = Date.parse(input.nowIso);
  if (!Number.isFinite(drilledMs) || !Number.isFinite(nowMs)) {
    return { status: 'degraded', detail: 'drill_timestamp_invalid' };
  }

  const ageDays = (nowMs - drilledMs) / (24 * 60 * 60 * 1000);
  if (ageDays > drill.maxAgeDays) {
    return {
      status: 'degraded',
      detail: `drill_stale;age_days=${String(Math.floor(ageDays))}`,
    };
  }

  return {
    status: 'ok',
    detail: `drill_passed;method=${input.latestAttestation.method}`,
  };
}
