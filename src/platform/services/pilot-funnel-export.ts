import type { Database } from '../../db/client.js';
import { findActiveCommunityBySlug } from '../../db/repositories/communities.js';
import { communityNotFoundError } from '../../errors/app-error.js';
import type { PilotCohort } from '../../db/schema.js';
import {
  countActivePilotCohortMembers,
  countMandatesForCommunity,
  countProposalsForCommunity,
  countSignalConfirmationsForCommunity,
  countStageEventsForCommunity,
  countVerificationConfirmationsForCommunity,
  countVotesForCommunity,
  listCivicProcessesForCommunity,
  type CommunityProcessSummary,
} from '../repositories/pilot-funnel.js';

type Db = Database['db'];

/**
 * Aggregate-only pilot funnel export: counts and process stages for one
 * community, plus the size of one cohort. No account-level identifiers are
 * included -- this is meant to be shareable (e.g. the public result page,
 * M7), not an investigative per-account export (see investigation-export.ts
 * for that, which stays account-scoped and operator-only).
 */
export type PilotFunnelExportPack = {
  readonly generatedAt: string;
  readonly community: { readonly slug: string; readonly displayName: string };
  readonly cohort: { readonly name: PilotCohort; readonly activeMembers: number };
  readonly signalConfirmations: number;
  readonly processes: CommunityProcessSummary[];
  readonly funnel: {
    readonly stageEventCounts: Readonly<Record<string, number>>;
    readonly proposals: number;
    readonly votes: number;
    readonly mandates: number;
    readonly verificationConfirmations: number;
  };
};

export async function buildPilotFunnelExport(
  db: Db,
  input: { communitySlug: string; cohort: PilotCohort; now: string },
): Promise<PilotFunnelExportPack> {
  const community = await findActiveCommunityBySlug(db, input.communitySlug);
  if (!community) {
    throw communityNotFoundError();
  }

  const [
    activeMembers,
    signalConfirmationsCount,
    processes,
    stageEventCounts,
    proposals,
    votes,
    mandates,
    verificationConfirmations,
  ] = await Promise.all([
    countActivePilotCohortMembers(db, input.cohort),
    countSignalConfirmationsForCommunity(db, community.id),
    listCivicProcessesForCommunity(db, community.id),
    countStageEventsForCommunity(db, community.id),
    countProposalsForCommunity(db, community.id),
    countVotesForCommunity(db, community.id),
    countMandatesForCommunity(db, community.id),
    countVerificationConfirmationsForCommunity(db, community.id),
  ]);

  return {
    generatedAt: input.now,
    community: { slug: community.slug, displayName: community.displayName },
    cohort: { name: input.cohort, activeMembers },
    signalConfirmations: signalConfirmationsCount,
    processes,
    funnel: {
      stageEventCounts,
      proposals,
      votes,
      mandates,
      verificationConfirmations,
    },
  };
}
