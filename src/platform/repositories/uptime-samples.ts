import { desc, notInArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import * as schema from '../../db/schema.js';
import {
  platformUptimeSamples,
  type PlatformComponentStatusValue,
  type PlatformOverallStatusValue,
  type PlatformUptimeSampleRow,
} from '../../db/schema.js';

type Db = NodePgDatabase<typeof schema>;

/** Keep newest N samples (~24h at one sample/minute). */
export const PLATFORM_UPTIME_SAMPLE_RETENTION = 288;

/** Minimum gap between persisted samples (status views are opportunistic). */
export const PLATFORM_UPTIME_SAMPLE_MIN_INTERVAL_MS = 60_000;

export type AppendPlatformUptimeSampleInput = {
  readonly id?: string;
  readonly sampledAt: string;
  readonly apiStatus: PlatformComponentStatusValue;
  readonly databaseStatus: PlatformComponentStatusValue;
  readonly emailStatus: PlatformComponentStatusValue;
  readonly stripeStatus: PlatformComponentStatusValue;
  readonly overallStatus: PlatformOverallStatusValue;
  readonly environment: string;
  readonly service: string;
  readonly version: string;
  readonly commitSha: string | null;
};

function boundText(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

export async function getLatestPlatformUptimeSample(
  db: Db,
): Promise<PlatformUptimeSampleRow | null> {
  const rows = await db
    .select()
    .from(platformUptimeSamples)
    .orderBy(desc(platformUptimeSamples.sampledAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function appendPlatformUptimeSample(
  db: Db,
  input: AppendPlatformUptimeSampleInput,
): Promise<PlatformUptimeSampleRow> {
  const id = input.id ?? randomUUID();
  const [row] = await db
    .insert(platformUptimeSamples)
    .values({
      id,
      sampledAt: input.sampledAt,
      apiStatus: input.apiStatus,
      databaseStatus: input.databaseStatus,
      emailStatus: input.emailStatus,
      stripeStatus: input.stripeStatus,
      overallStatus: input.overallStatus,
      environment: boundText(input.environment, 32),
      service: boundText(input.service, 64),
      version: boundText(input.version, 64),
      commitSha: input.commitSha === null ? null : boundText(input.commitSha, 64),
    })
    .returning();

  if (!row) {
    throw new Error('Failed to append platform uptime sample');
  }

  try {
    const keep = await db
      .select({ id: platformUptimeSamples.id })
      .from(platformUptimeSamples)
      .orderBy(desc(platformUptimeSamples.sampledAt))
      .limit(PLATFORM_UPTIME_SAMPLE_RETENTION);
    const keepIds = keep.map((item) => item.id);
    if (keepIds.length >= PLATFORM_UPTIME_SAMPLE_RETENTION) {
      await db.delete(platformUptimeSamples).where(notInArray(platformUptimeSamples.id, keepIds));
    }
  } catch {
    // ignore prune failures
  }

  return row;
}

export async function listPlatformUptimeSamples(
  db: Db,
  options?: { limit?: number },
): Promise<PlatformUptimeSampleRow[]> {
  const limit = Math.min(Math.max(options?.limit ?? 48, 1), 96);
  return db
    .select()
    .from(platformUptimeSamples)
    .orderBy(desc(platformUptimeSamples.sampledAt))
    .limit(limit);
}

export async function summarizePlatformUptimeSamples(
  db: Db,
  options?: { limit?: number },
): Promise<{
  samples: PlatformUptimeSampleRow[];
  sampleCount: number;
  okCount: number;
  okRatio: number | null;
  windowStartedAt: string | null;
  windowEndedAt: string | null;
}> {
  const samples = await listPlatformUptimeSamples(db, options);
  const sampleCount = samples.length;
  const okCount = samples.filter((row) => row.overallStatus === 'ok').length;
  const okRatio = sampleCount === 0 ? null : okCount / sampleCount;
  const windowEndedAt = samples[0]?.sampledAt ?? null;
  const windowStartedAt = samples[sampleCount - 1]?.sampledAt ?? null;
  return { samples, sampleCount, okCount, okRatio, windowStartedAt, windowEndedAt };
}

export async function countPlatformUptimeSamples(db: Db): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(platformUptimeSamples);
  return rows[0]?.n ?? 0;
}
