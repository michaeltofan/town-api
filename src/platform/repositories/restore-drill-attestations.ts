import { desc, notInArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import * as schema from '../../db/schema.js';
import {
  platformRestoreDrillAttestations,
  type PlatformRestoreDrillAttestationRow,
  type PlatformRestoreDrillMethodValue,
  type PlatformRestoreDrillOutcomeValue,
} from '../../db/schema.js';

type Db = NodePgDatabase<typeof schema>;

export const PLATFORM_RESTORE_DRILL_ATTESTATION_RETENTION = 50;

export type AppendPlatformRestoreDrillAttestationInput = {
  readonly id?: string;
  readonly drilledAt: string;
  readonly drilledByAccountId: string;
  readonly method: PlatformRestoreDrillMethodValue;
  readonly outcome: PlatformRestoreDrillOutcomeValue;
  readonly restorePointAt: string | null;
  readonly note: string | null;
  readonly environment: string;
  readonly commitSha: string | null;
};

function boundText(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

export async function getLatestPlatformRestoreDrillAttestation(
  db: Db,
): Promise<PlatformRestoreDrillAttestationRow | null> {
  const rows = await db
    .select()
    .from(platformRestoreDrillAttestations)
    .orderBy(desc(platformRestoreDrillAttestations.drilledAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function listPlatformRestoreDrillAttestations(
  db: Db,
  options?: { limit?: number },
): Promise<PlatformRestoreDrillAttestationRow[]> {
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 50);
  return db
    .select()
    .from(platformRestoreDrillAttestations)
    .orderBy(desc(platformRestoreDrillAttestations.drilledAt))
    .limit(limit);
}

export async function appendPlatformRestoreDrillAttestation(
  db: Db,
  input: AppendPlatformRestoreDrillAttestationInput,
): Promise<PlatformRestoreDrillAttestationRow> {
  const id = input.id ?? randomUUID();
  const [row] = await db
    .insert(platformRestoreDrillAttestations)
    .values({
      id,
      drilledAt: input.drilledAt,
      drilledByAccountId: input.drilledByAccountId,
      method: input.method,
      outcome: input.outcome,
      restorePointAt: input.restorePointAt,
      note: input.note === null ? null : boundText(input.note, 240),
      environment: boundText(input.environment, 32),
      commitSha: input.commitSha === null ? null : boundText(input.commitSha, 64),
    })
    .returning();

  if (!row) {
    throw new Error('Failed to append platform restore drill attestation');
  }

  try {
    const keep = await db
      .select({ id: platformRestoreDrillAttestations.id })
      .from(platformRestoreDrillAttestations)
      .orderBy(desc(platformRestoreDrillAttestations.drilledAt))
      .limit(PLATFORM_RESTORE_DRILL_ATTESTATION_RETENTION);
    const keepIds = keep.map((item) => item.id);
    if (keepIds.length >= PLATFORM_RESTORE_DRILL_ATTESTATION_RETENTION) {
      await db
        .delete(platformRestoreDrillAttestations)
        .where(notInArray(platformRestoreDrillAttestations.id, keepIds));
    }
  } catch {
    // ignore prune failures
  }

  return row;
}
