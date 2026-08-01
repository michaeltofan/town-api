import type {
  PlatformComponentCheck,
  PlatformComponentStatus,
  PlatformOperationalComponents,
} from './status-checks.js';

/**
 * Pure helpers for platform uptime samples and in-console alerts.
 * Details stay short and secret-free (component probe tokens only).
 */

/** Components persisted into uptime sample rows. */
export const PLATFORM_UPTIME_COMPONENTS = ['api', 'database', 'email', 'stripe'] as const;

/** Components that open/resolve in-console alerts (includes backup attestation). */
export const PLATFORM_ALERT_COMPONENTS = ['api', 'database', 'email', 'stripe', 'backup'] as const;

export type PlatformUptimeComponent = (typeof PLATFORM_UPTIME_COMPONENTS)[number];
export type PlatformAlertComponent = (typeof PLATFORM_ALERT_COMPONENTS)[number];

export type PlatformAlertSeverity = 'warning' | 'critical';

export type PlatformAlertStatus = Exclude<PlatformComponentStatus, 'ok' | 'disabled'>;

export type PlatformOverallStatus = Exclude<PlatformComponentStatus, 'disabled'>;

const STATUS_RANK: Record<PlatformComponentStatus, number> = {
  ok: 0,
  disabled: 0,
  degraded: 1,
  misconfigured: 2,
  timeout: 3,
  fail: 4,
};

const SECRETISH =
  /(password|passwd|secret|token|authorization|cookie|api[_-]?key|bearer|private[_-]?key|database_url|postgres(ql)?:\/\/)/i;

export function isUnhealthyComponentStatus(
  status: PlatformComponentStatus,
): status is PlatformAlertStatus {
  return (
    status === 'degraded' || status === 'fail' || status === 'timeout' || status === 'misconfigured'
  );
}

export function alertSeverityForStatus(status: PlatformAlertStatus): PlatformAlertSeverity {
  if (status === 'fail' || status === 'timeout') return 'critical';
  return 'warning';
}

export function deriveOverallStatus(
  components: PlatformOperationalComponents,
): PlatformOverallStatus {
  let worst: PlatformOverallStatus = 'ok';
  let worstRank = 0;
  // Overall health includes backup attestation, but sample rows still store only uptime comps.
  for (const name of PLATFORM_ALERT_COMPONENTS) {
    const status = components[name].status;
    if (status === 'disabled' || status === 'ok') continue;
    const rank = STATUS_RANK[status];
    if (rank > worstRank) {
      worstRank = rank;
      worst = status;
    }
  }
  return worst;
}

export function sanitizeComponentDetail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  if (SECRETISH.test(text) || text.includes('@')) {
    return 'redacted';
  }
  if (text.length > 160) {
    text = `${text.slice(0, 157)}...`;
  }
  return text;
}

export function sampleIsHealthy(overallStatus: PlatformOverallStatus): boolean {
  return overallStatus === 'ok';
}

export function componentStatusesFromSample(row: {
  apiStatus: PlatformComponentStatus;
  databaseStatus: PlatformComponentStatus;
  emailStatus: PlatformComponentStatus;
  stripeStatus: PlatformComponentStatus;
}): PlatformOperationalComponents {
  const wrap = (status: PlatformComponentStatus): PlatformComponentCheck => ({
    status,
    detail: null,
  });
  return {
    api: wrap(row.apiStatus),
    database: wrap(row.databaseStatus),
    email: wrap(row.emailStatus),
    stripe: wrap(row.stripeStatus),
    // Samples do not store backup; treat as disabled for reconstruction helpers.
    backup: wrap('disabled'),
  };
}
