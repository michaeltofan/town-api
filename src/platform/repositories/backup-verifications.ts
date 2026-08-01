import { desc, notInArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import * as schema from '../../db/schema.js';
import {
  platformBackupVerifications,
  type PlatformBackupProviderValue,
  type PlatformBackupVerificationRow,
} from '../../db/schema.js';

type Db = NodePgDatabase<typeof schema>;

export const PLATFORM_BACKUP_VERIFICATION_RETENTION = 50;

export type AppendPlatformBackupVerificationInput = {
  readonly id?: string;
  readonly verifiedAt: string;
  readonly verifiedByAccountId: string;
  readonly provider: PlatformBackupProviderValue;
  readonly pitrEnabled: boolean;
  readonly retentionDays: number | null;
  readonly note: string | null;
  readonly environment: string;
  readonly commitSha: string | null;
};

function boundText(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

export async function getLatestPlatformBackupVerification(
  db: Db,
): Promise<PlatformBackupVerificationRow | null> {
  const rows = await db
    .select()
    .from(platformBackupVerifications)
    .orderBy(desc(platformBackupVerifications.verifiedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function listPlatformBackupVerifications(
  db: Db,
  options?: { limit?: number },
): Promise<PlatformBackupVerificationRow[]> {
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 50);
  return db
    .select()
    .from(platformBackupVerifications)
    .orderBy(desc(platformBackupVerifications.verifiedAt))
    .limit(limit);
}

export async function appendPlatformBackupVerification(
  db: Db,
  input: AppendPlatformBackupVerificationInput,
): Promise<PlatformBackupVerificationRow> {
  const id = input.id ?? randomUUID();
  const [row] = await db
    .insert(platformBackupVerifications)
    .values({
      id,
      verifiedAt: input.verifiedAt,
      verifiedByAccountId: input.verifiedByAccountId,
      provider: input.provider,
      pitrEnabled: input.pitrEnabled,
      retentionDays: input.retentionDays,
      note: input.note === null ? null : boundText(input.note, 240),
      environment: boundText(input.environment, 32),
      commitSha: input.commitSha === null ? null : boundText(input.commitSha, 64),
    })
    .returning();

  if (!row) {
    throw new Error('Failed to append platform backup verification');
  }

  try {
    const keep = await db
      .select({ id: platformBackupVerifications.id })
      .from(platformBackupVerifications)
      .orderBy(desc(platformBackupVerifications.verifiedAt))
      .limit(PLATFORM_BACKUP_VERIFICATION_RETENTION);
    const keepIds = keep.map((item) => item.id);
    if (keepIds.length >= PLATFORM_BACKUP_VERIFICATION_RETENTION) {
      await db
        .delete(platformBackupVerifications)
        .where(notInArray(platformBackupVerifications.id, keepIds));
    }
  } catch {
    // ignore prune failures
  }

  return row;
}
