import { and, count, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  civicMandates,
  civicProcesses,
  civicProcessEvents,
  civicProposals,
  civicVerificationConfirmations,
  civicVotes,
  pilotCohortMembers,
  signalConfirmations,
  signals,
  type PilotCohort,
} from '../../db/schema.js';

type Db = Database['db'];

export async function countActivePilotCohortMembers(db: Db, cohort: PilotCohort): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(pilotCohortMembers)
    .where(and(eq(pilotCohortMembers.cohort, cohort), isNull(pilotCohortMembers.revokedAt)));
  return rows[0]?.value ?? 0;
}

export async function countSignalConfirmationsForCommunity(
  db: Db,
  communityId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(signalConfirmations)
    .innerJoin(signals, eq(signals.id, signalConfirmations.signalId))
    .where(eq(signals.communityId, communityId));
  return rows[0]?.value ?? 0;
}

export type CommunityProcessSummary = {
  signalSlug: string;
  currentStage: string;
  ballotCycle: number;
};

export async function listCivicProcessesForCommunity(
  db: Db,
  communityId: string,
): Promise<CommunityProcessSummary[]> {
  const rows = await db
    .select({
      signalSlug: signals.slug,
      currentStage: civicProcesses.currentStage,
      ballotCycle: civicProcesses.ballotCycle,
    })
    .from(civicProcesses)
    .innerJoin(signals, eq(signals.id, civicProcesses.signalId))
    .where(eq(civicProcesses.communityId, communityId));
  return rows;
}

/** Funnel counts: how many community processes ever reached each stage. */
export async function countStageEventsForCommunity(
  db: Db,
  communityId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ eventType: civicProcessEvents.eventType, value: count() })
    .from(civicProcessEvents)
    .innerJoin(civicProcesses, eq(civicProcesses.id, civicProcessEvents.processId))
    .where(eq(civicProcesses.communityId, communityId))
    .groupBy(civicProcessEvents.eventType);

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.eventType] = row.value;
  }
  return counts;
}

export async function countProposalsForCommunity(db: Db, communityId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(civicProposals)
    .innerJoin(civicProcesses, eq(civicProcesses.id, civicProposals.processId))
    .where(eq(civicProcesses.communityId, communityId));
  return rows[0]?.value ?? 0;
}

export async function countVotesForCommunity(db: Db, communityId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(civicVotes)
    .innerJoin(civicProcesses, eq(civicProcesses.id, civicVotes.processId))
    .where(eq(civicProcesses.communityId, communityId));
  return rows[0]?.value ?? 0;
}

export async function countMandatesForCommunity(db: Db, communityId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(civicMandates)
    .innerJoin(civicProcesses, eq(civicProcesses.id, civicMandates.processId))
    .where(eq(civicProcesses.communityId, communityId));
  return rows[0]?.value ?? 0;
}

export async function countVerificationConfirmationsForCommunity(
  db: Db,
  communityId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(civicVerificationConfirmations)
    .innerJoin(civicProcesses, eq(civicProcesses.id, civicVerificationConfirmations.processId))
    .where(eq(civicProcesses.communityId, communityId));
  return rows[0]?.value ?? 0;
}
