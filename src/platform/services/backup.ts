import type { Env } from '../../config/env.js';
import type { PlatformBackupVerificationRow } from '../../db/schema.js';
import type { PlatformComponentCheck } from './status-checks.js';

export type PlatformBackupProvider = 'none' | 'railway_postgres_pitr';

export type PlatformBackupConfig = {
  readonly provider: PlatformBackupProvider;
  readonly pitrEnabled: boolean;
  readonly retentionDays: number | null;
  readonly verifyMaxAgeDays: number;
  readonly automated: boolean;
};

const SECRETISH =
  /(password|passwd|secret|token|authorization|cookie|api[_-]?key|bearer|private[_-]?key|database_url|postgres(ql)?:\/\/)/i;

export function readPlatformBackupConfig(env: Env): PlatformBackupConfig {
  const provider = env.DATABASE_BACKUP_PROVIDER;
  const pitrEnabled = env.DATABASE_BACKUP_PITR_ENABLED;
  const retentionDays =
    typeof env.DATABASE_BACKUP_RETENTION_DAYS === 'number'
      ? env.DATABASE_BACKUP_RETENTION_DAYS
      : null;
  const verifyMaxAgeDays = env.DATABASE_BACKUP_VERIFY_MAX_AGE_DAYS;
  return {
    provider,
    pitrEnabled,
    retentionDays,
    verifyMaxAgeDays,
    automated: provider === 'railway_postgres_pitr' && pitrEnabled,
  };
}

export function sanitizeBackupNote(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  if (SECRETISH.test(text) || text.includes('@')) {
    return null;
  }
  if (text.length > 240) {
    text = `${text.slice(0, 237)}...`;
  }
  return text;
}

/**
 * Assess automated backup (Railway Postgres PITR) for Monitor.
 * Development/test may disable; staging/production should enable PITR + fresh verification.
 */
export function assessBackupComponent(input: {
  env: Env;
  latestVerification: PlatformBackupVerificationRow | null;
  nowIso: string;
}): PlatformComponentCheck {
  const config = readPlatformBackupConfig(input.env);

  if (config.provider === 'none' || !config.pitrEnabled) {
    if (input.env.APP_ENV === 'development' || input.env.APP_ENV === 'test') {
      return { status: 'disabled', detail: 'backup_disabled' };
    }
    return { status: 'misconfigured', detail: 'pitr_not_configured' };
  }

  if (config.retentionDays === null || config.retentionDays < 1) {
    return { status: 'misconfigured', detail: 'retention_missing' };
  }

  if (!input.latestVerification) {
    return {
      status: 'degraded',
      detail: `verification_missing;retention_days=${String(config.retentionDays)}`,
    };
  }

  const verifiedMs = Date.parse(input.latestVerification.verifiedAt);
  const nowMs = Date.parse(input.nowIso);
  if (!Number.isFinite(verifiedMs) || !Number.isFinite(nowMs)) {
    return { status: 'degraded', detail: 'verification_timestamp_invalid' };
  }

  const ageDays = (nowMs - verifiedMs) / (24 * 60 * 60 * 1000);
  if (ageDays > config.verifyMaxAgeDays) {
    return {
      status: 'degraded',
      detail: `verification_stale;age_days=${String(Math.floor(ageDays))}`,
    };
  }

  return {
    status: 'ok',
    detail: `railway_pitr;retention_days=${String(config.retentionDays)}`,
  };
}
