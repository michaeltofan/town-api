import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  pilotCohortMembers,
  type PilotCohort,
  type PilotCohortMemberRow,
} from '../../db/schema.js';

type Db = Database['db'];

export async function findActivePilotCohortMembership(
  db: Db,
  accountId: string,
  cohort: PilotCohort,
): Promise<PilotCohortMemberRow | null> {
  const rows = await db
    .select()
    .from(pilotCohortMembers)
    .where(
      and(
        eq(pilotCohortMembers.accountId, accountId),
        eq(pilotCohortMembers.cohort, cohort),
        isNull(pilotCohortMembers.revokedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function insertPilotCohortMember(
  db: Db,
  input: {
    id: string;
    accountId: string;
    cohort: PilotCohort;
    grantedAt: string;
    grantedByAccountId: string;
    membershipSourceEventId: string | null;
  },
): Promise<PilotCohortMemberRow> {
  const rows = await db
    .insert(pilotCohortMembers)
    .values({
      id: input.id,
      accountId: input.accountId,
      cohort: input.cohort,
      grantedAt: input.grantedAt,
      grantedByAccountId: input.grantedByAccountId,
      membershipSourceEventId: input.membershipSourceEventId,
      createdAt: input.grantedAt,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('pilot_cohort_members insert returned no row');
  }
  return row;
}

/** Active members of one pilot cohort, most recently granted first. */
export async function listActivePilotCohortMembers(
  db: Db,
  cohort: PilotCohort,
): Promise<PilotCohortMemberRow[]> {
  return db
    .select()
    .from(pilotCohortMembers)
    .where(and(eq(pilotCohortMembers.cohort, cohort), isNull(pilotCohortMembers.revokedAt)));
}
