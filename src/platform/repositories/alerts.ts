import { and, desc, eq, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import * as schema from '../../db/schema.js';
import {
  platformAlerts,
  type PlatformAlertRow,
  type PlatformAlertSeverityValue,
  type PlatformAlertStatusValue,
  type PlatformUptimeComponentValue,
} from '../../db/schema.js';

type Db = NodePgDatabase<typeof schema>;

/** Keep newest N alert rows (open + resolved). */
export const PLATFORM_ALERT_RETENTION = 200;

export type OpenOrRefreshPlatformAlertInput = {
  readonly id?: string;
  readonly openedAt: string;
  readonly component: PlatformUptimeComponentValue;
  readonly status: PlatformAlertStatusValue;
  readonly severity: PlatformAlertSeverityValue;
  readonly detail: string | null;
  readonly environment: string;
  readonly commitSha: string | null;
};

function boundText(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

async function prunePlatformAlerts(db: Db): Promise<void> {
  try {
    const keep = await db
      .select({ id: platformAlerts.id })
      .from(platformAlerts)
      .orderBy(desc(platformAlerts.openedAt))
      .limit(PLATFORM_ALERT_RETENTION);
    const keepIds = keep.map((item) => item.id);
    if (keepIds.length >= PLATFORM_ALERT_RETENTION) {
      await db.delete(platformAlerts).where(notInArray(platformAlerts.id, keepIds));
    }
  } catch {
    // ignore prune failures
  }
}

export async function findOpenPlatformAlertForComponent(
  db: Db,
  component: PlatformUptimeComponentValue,
): Promise<PlatformAlertRow | null> {
  const rows = await db
    .select()
    .from(platformAlerts)
    .where(and(eq(platformAlerts.component, component), isNull(platformAlerts.resolvedAt)))
    .orderBy(desc(platformAlerts.openedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function openOrRefreshPlatformAlert(
  db: Db,
  input: OpenOrRefreshPlatformAlertInput,
): Promise<PlatformAlertRow> {
  const existing = await findOpenPlatformAlertForComponent(db, input.component);
  if (existing) {
    if (
      existing.status === input.status &&
      existing.severity === input.severity &&
      existing.detail === input.detail
    ) {
      return existing;
    }
    const [updated] = await db
      .update(platformAlerts)
      .set({
        status: input.status,
        severity: input.severity,
        detail: input.detail,
        commitSha: input.commitSha === null ? null : boundText(input.commitSha, 64),
      })
      .where(eq(platformAlerts.id, existing.id))
      .returning();
    if (!updated) {
      throw new Error('Failed to refresh platform alert');
    }
    return updated;
  }

  const id = input.id ?? randomUUID();
  const [row] = await db
    .insert(platformAlerts)
    .values({
      id,
      openedAt: input.openedAt,
      component: input.component,
      status: input.status,
      severity: input.severity,
      detail: input.detail,
      environment: boundText(input.environment, 32),
      commitSha: input.commitSha === null ? null : boundText(input.commitSha, 64),
      resolvedAt: null,
      acknowledgedAt: null,
      acknowledgedByAccountId: null,
    })
    .returning();

  if (!row) {
    throw new Error('Failed to open platform alert');
  }

  await prunePlatformAlerts(db);
  return row;
}

export async function resolveOpenPlatformAlert(
  db: Db,
  input: { component: PlatformUptimeComponentValue; resolvedAt: string },
): Promise<PlatformAlertRow | null> {
  const existing = await findOpenPlatformAlertForComponent(db, input.component);
  if (!existing) return null;
  const [updated] = await db
    .update(platformAlerts)
    .set({ resolvedAt: input.resolvedAt })
    .where(eq(platformAlerts.id, existing.id))
    .returning();
  return updated ?? null;
}

export async function acknowledgePlatformAlert(
  db: Db,
  input: {
    alertId: string;
    acknowledgedAt: string;
    acknowledgedByAccountId: string;
  },
): Promise<{ row: PlatformAlertRow; changed: boolean } | null> {
  const rows = await db
    .select()
    .from(platformAlerts)
    .where(eq(platformAlerts.id, input.alertId))
    .limit(1);
  const existing = rows[0];
  if (!existing) return null;
  if (existing.acknowledgedAt !== null) {
    return { row: existing, changed: false };
  }
  const [updated] = await db
    .update(platformAlerts)
    .set({
      acknowledgedAt: input.acknowledgedAt,
      acknowledgedByAccountId: input.acknowledgedByAccountId,
    })
    .where(eq(platformAlerts.id, existing.id))
    .returning();
  if (!updated) {
    throw new Error('Failed to acknowledge platform alert');
  }
  return { row: updated, changed: true };
}

export async function listPlatformAlerts(
  db: Db,
  options?: { limit?: number; state?: 'open' | 'resolved' | 'all' },
): Promise<PlatformAlertRow[]> {
  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 50);
  const state = options?.state ?? 'open';
  const base = db.select().from(platformAlerts);
  const filtered =
    state === 'open'
      ? base.where(isNull(platformAlerts.resolvedAt))
      : state === 'resolved'
        ? base.where(isNotNull(platformAlerts.resolvedAt))
        : base;
  return filtered.orderBy(desc(platformAlerts.openedAt)).limit(limit);
}

export async function countOpenPlatformAlerts(db: Db): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(platformAlerts)
    .where(isNull(platformAlerts.resolvedAt));
  return rows[0]?.n ?? 0;
}
