import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';
import {
  appendPlatformUptimeSample,
  getLatestPlatformUptimeSample,
  PLATFORM_UPTIME_SAMPLE_MIN_INTERVAL_MS,
} from '../repositories/uptime-samples.js';
import { openOrRefreshPlatformAlert, resolveOpenPlatformAlert } from '../repositories/alerts.js';
import type { PlatformOperationalComponents } from './status-checks.js';
import {
  alertSeverityForStatus,
  deriveOverallStatus,
  isUnhealthyComponentStatus,
  PLATFORM_ALERT_COMPONENTS,
  sanitizeComponentDetail,
} from './uptime-alerts.js';

type Db = NodePgDatabase<typeof schema>;

export type RecordUptimeObservationInput = {
  readonly sampledAt: string;
  readonly components: PlatformOperationalComponents;
  readonly environment: string;
  readonly service: string;
  readonly version: string;
  readonly commitSha: string | null;
  /** When true, bypass the sample throttle (tests / forced sample). */
  readonly force?: boolean;
};

/**
 * Persist a throttled uptime sample and sync in-console component alerts.
 * Failures must never break the caller (status response stays authoritative).
 */
export async function recordUptimeObservation(
  db: Db,
  input: RecordUptimeObservationInput,
): Promise<{ sampled: boolean }> {
  const overallStatus = deriveOverallStatus(input.components);

  if (!input.force) {
    const latest = await getLatestPlatformUptimeSample(db);
    if (latest) {
      const latestMs = Date.parse(latest.sampledAt);
      const nowMs = Date.parse(input.sampledAt);
      if (
        Number.isFinite(latestMs) &&
        Number.isFinite(nowMs) &&
        nowMs - latestMs < PLATFORM_UPTIME_SAMPLE_MIN_INTERVAL_MS
      ) {
        // Still sync alerts so a sudden failure is visible even when throttled.
        await syncComponentAlerts(db, input);
        return { sampled: false };
      }
    }
  }

  await appendPlatformUptimeSample(db, {
    sampledAt: input.sampledAt,
    apiStatus: input.components.api.status,
    databaseStatus: input.components.database.status,
    emailStatus: input.components.email.status,
    stripeStatus: input.components.stripe.status,
    overallStatus,
    environment: input.environment,
    service: input.service,
    version: input.version,
    commitSha: input.commitSha,
  });

  await syncComponentAlerts(db, input);
  return { sampled: true };
}

async function syncComponentAlerts(db: Db, input: RecordUptimeObservationInput): Promise<void> {
  for (const component of PLATFORM_ALERT_COMPONENTS) {
    const check = input.components[component];
    if (isUnhealthyComponentStatus(check.status)) {
      await openOrRefreshPlatformAlert(db, {
        openedAt: input.sampledAt,
        component,
        status: check.status,
        severity: alertSeverityForStatus(check.status),
        detail: sanitizeComponentDetail(check.detail),
        environment: input.environment,
        commitSha: input.commitSha,
      });
    } else {
      await resolveOpenPlatformAlert(db, {
        component,
        resolvedAt: input.sampledAt,
      });
    }
  }
}
