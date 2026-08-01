import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  platformOperators,
  type PlatformOperatorRole,
  type PlatformOperatorRow,
} from '../../db/schema.js';

type Db = Database['db'];

export async function findActivePlatformOperator(
  db: Db,
  accountId: string,
): Promise<PlatformOperatorRow | null> {
  const rows = await db
    .select()
    .from(platformOperators)
    .where(and(eq(platformOperators.accountId, accountId), isNull(platformOperators.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listActivePlatformOperators(db: Db): Promise<PlatformOperatorRow[]> {
  return db
    .select()
    .from(platformOperators)
    .where(isNull(platformOperators.revokedAt))
    .orderBy(asc(platformOperators.grantedAt));
}

export async function upsertPlatformOperator(
  db: Db,
  input: {
    accountId: string;
    role: PlatformOperatorRole;
    grantedByAccountId: string | null;
    at: string;
  },
): Promise<{ row: PlatformOperatorRow; outcome: 'granted' | 'already_active' | 'role_changed' }> {
  const existing = await db
    .select()
    .from(platformOperators)
    .where(eq(platformOperators.accountId, input.accountId))
    .limit(1);
  const current = existing[0];

  if (current?.revokedAt === null) {
    if (current.role === input.role) {
      return { row: current, outcome: 'already_active' };
    }
    const updated = await db
      .update(platformOperators)
      .set({
        role: input.role,
        updatedAt: input.at,
      })
      .where(eq(platformOperators.accountId, input.accountId))
      .returning();
    const row = updated[0];
    if (!row) {
      throw new Error('Failed to update platform operator role');
    }
    return { row, outcome: 'role_changed' };
  }

  if (current) {
    const restored = await db
      .update(platformOperators)
      .set({
        role: input.role,
        grantedAt: input.at,
        grantedByAccountId: input.grantedByAccountId,
        revokedAt: null,
        updatedAt: input.at,
      })
      .where(eq(platformOperators.accountId, input.accountId))
      .returning();
    const row = restored[0];
    if (!row) {
      throw new Error('Failed to restore platform operator');
    }
    return { row, outcome: 'granted' };
  }

  const inserted = await db
    .insert(platformOperators)
    .values({
      accountId: input.accountId,
      role: input.role,
      grantedAt: input.at,
      grantedByAccountId: input.grantedByAccountId,
      revokedAt: null,
      updatedAt: input.at,
    })
    .returning();
  const row = inserted[0];
  if (!row) {
    throw new Error('Failed to grant platform operator');
  }
  return { row, outcome: 'granted' };
}

export async function revokePlatformOperator(
  db: Db,
  input: { accountId: string; at: string },
): Promise<{ row: PlatformOperatorRow; changed: boolean } | null> {
  const existing = await db
    .select()
    .from(platformOperators)
    .where(eq(platformOperators.accountId, input.accountId))
    .limit(1);
  const current = existing[0];
  if (!current) {
    return null;
  }
  if (current.revokedAt !== null) {
    return { row: current, changed: false };
  }
  const updated = await db
    .update(platformOperators)
    .set({
      revokedAt: input.at,
      updatedAt: input.at,
    })
    .where(eq(platformOperators.accountId, input.accountId))
    .returning();
  const row = updated[0];
  if (!row) {
    throw new Error('Failed to revoke platform operator');
  }
  return { row, changed: true };
}
