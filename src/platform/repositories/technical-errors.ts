import { desc, notInArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import * as schema from '../../db/schema.js';
import { platformTechnicalErrors, type PlatformTechnicalErrorRow } from '../../db/schema.js';

type Db = NodePgDatabase<typeof schema>;

/** Keep only the newest N rows so the buffer stays bounded. */
export const PLATFORM_TECHNICAL_ERROR_RETENTION = 200;

export type AppendPlatformTechnicalErrorInput = {
  readonly id?: string;
  readonly occurredAt: string;
  readonly requestId: string;
  readonly method: string | null;
  readonly route: string | null;
  readonly statusCode: number;
  readonly errorCode: string;
  readonly errorName: string | null;
  readonly message: string;
  readonly environment: string;
  readonly service: string;
  readonly version: string;
  readonly commitSha: string | null;
};

function boundText(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

export async function appendPlatformTechnicalError(
  db: Db,
  input: AppendPlatformTechnicalErrorInput,
): Promise<PlatformTechnicalErrorRow> {
  const id = input.id ?? randomUUID();
  const [row] = await db
    .insert(platformTechnicalErrors)
    .values({
      id,
      occurredAt: input.occurredAt,
      requestId: boundText(input.requestId, 128),
      method: input.method === null ? null : boundText(input.method, 16),
      route: input.route === null ? null : boundText(input.route, 160),
      statusCode: input.statusCode,
      errorCode: boundText(input.errorCode, 80),
      errorName: input.errorName === null ? null : boundText(input.errorName, 80),
      message: boundText(input.message, 240),
      environment: boundText(input.environment, 32),
      service: boundText(input.service, 64),
      version: boundText(input.version, 64),
      commitSha: input.commitSha === null ? null : boundText(input.commitSha, 64),
    })
    .returning();

  if (!row) {
    throw new Error('Failed to append platform technical error');
  }

  // Best-effort prune; never fail the append path if cleanup races.
  try {
    const keep = await db
      .select({ id: platformTechnicalErrors.id })
      .from(platformTechnicalErrors)
      .orderBy(desc(platformTechnicalErrors.occurredAt))
      .limit(PLATFORM_TECHNICAL_ERROR_RETENTION);
    const keepIds = keep.map((item) => item.id);
    if (keepIds.length >= PLATFORM_TECHNICAL_ERROR_RETENTION) {
      await db
        .delete(platformTechnicalErrors)
        .where(notInArray(platformTechnicalErrors.id, keepIds));
    }
  } catch {
    // ignore prune failures
  }

  return row;
}

export async function listPlatformTechnicalErrors(
  db: Db,
  options?: { limit?: number },
): Promise<PlatformTechnicalErrorRow[]> {
  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 50);
  return db
    .select()
    .from(platformTechnicalErrors)
    .orderBy(desc(platformTechnicalErrors.occurredAt))
    .limit(limit);
}

export async function countPlatformTechnicalErrors(db: Db): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(platformTechnicalErrors);
  return rows[0]?.n ?? 0;
}
