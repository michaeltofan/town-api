import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

type Db = Database['db'];

export const CIVIC_CONFIRMATION_THRESHOLD = 5;
export const CIVIC_PROPOSAL_THRESHOLD = 5;
export const CIVIC_DELIBERATION_THRESHOLD = 5;
export const CIVIC_BALLOT_QUORUM = 5;
export const CIVIC_BALLOT_QUESTION = "Which proposal should this signal's mandate be?";

export type PublicCivicProcessStage =
  | 'confirmation'
  | 'proposals'
  | 'deliberation'
  | 'ballot_preparation'
  | 'voting'
  | 'mandate'
  | 'action'
  | 'verification'
  | 'archived';

export type CivicProcessReadRow = {
  id: string;
  signalId: string;
  communityId: string;
  currentStage: PublicCivicProcessStage;
  votingOpensAt: string | null;
  votingClosesAt: string | null;
  ballotCycle: number;
  createdAt: string;
  updatedAt: string;
};

export type PublicCivicProcessEvent = {
  eventType:
    | 'process_created'
    | 'stage_transitioned_to_proposals'
    | 'stage_transitioned_to_deliberation'
    | 'stage_transitioned_to_ballot_preparation'
    | 'stage_transitioned_to_voting'
    | 'stage_returned_to_deliberation_after_quorum_failure'
    | 'stage_transitioned_to_mandate'
    | 'stage_transitioned_to_action'
    | 'stage_transitioned_to_verification'
    | 'stage_transitioned_to_archived';
  occurredAt: string;
};

export async function findCivicProcessBySignalId(
  db: Db,
  signalId: string,
): Promise<CivicProcessReadRow | null> {
  const result = await db.execute<{
    id: string;
    signal_id: string;
    community_id: string;
    current_stage: string;
    voting_opens_at: string | null;
    voting_closes_at: string | null;
    ballot_cycle: number;
    created_at: string;
    updated_at: string;
  }>(sql`
    SELECT id, signal_id, community_id, current_stage, voting_opens_at, voting_closes_at,
           ballot_cycle, created_at, updated_at
    FROM town.civic_processes
    WHERE signal_id = ${signalId}
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  if (
    row.current_stage !== 'confirmation' &&
    row.current_stage !== 'proposals' &&
    row.current_stage !== 'deliberation' &&
    row.current_stage !== 'ballot_preparation' &&
    row.current_stage !== 'voting' &&
    row.current_stage !== 'mandate' &&
    row.current_stage !== 'action' &&
    row.current_stage !== 'verification' &&
    row.current_stage !== 'archived'
  ) {
    throw new Error('Unsupported civic process stage');
  }
  return {
    id: row.id,
    signalId: row.signal_id,
    communityId: row.community_id,
    currentStage: row.current_stage,
    votingOpensAt: row.voting_opens_at,
    votingClosesAt: row.voting_closes_at,
    ballotCycle: row.ballot_cycle,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Provisions the canonical civic process for a published signal that is
 * missing one — mirrors the `signals_provision_civic_process` trigger and the
 * one-time migration 0041 backfill, for signals that slipped through both
 * (e.g. upserted via ON CONFLICT DO UPDATE, which does not re-fire an
 * AFTER INSERT trigger). Idempotent: safe to call whenever a read finds the
 * process missing, including under concurrent requests.
 */
export async function provisionMissingCivicProcess(
  db: Db,
  params: {
    processId: string;
    eventId: string;
    signalId: string;
    communityId: string;
    createdAt: string;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO town.civic_processes (id, signal_id, community_id, current_stage, created_at, updated_at)
    VALUES (${params.processId}, ${params.signalId}, ${params.communityId}, 'confirmation', ${params.createdAt}, ${params.createdAt})
    ON CONFLICT (signal_id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO town.civic_process_events (id, process_id, event_type, occurred_at)
    SELECT ${params.eventId}, id, 'process_created', ${params.createdAt}
    FROM town.civic_processes
    WHERE signal_id = ${params.signalId}
    ON CONFLICT (process_id, event_type, ballot_cycle) DO NOTHING
  `);
}

/**
 * There is no scheduled job: the 10-minute ballot-preparation freeze window
 * is only ever closed lazily, the moment any request touches a process
 * whose voting_opens_at has passed. Row-locked and idempotent, so
 * concurrent requests race safely. Proposal freezing and the eligible-voter
 * snapshot already happened synchronously when ballot_preparation began
 * (see the advance_civic_process_after_deliberation DB trigger) — this only
 * flips the stage itself once the fixed freeze window has elapsed.
 */
export async function openVotingIfBallotPreparationElapsed(
  db: Db,
  input: { processId: string; now: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.execute<{
      current_stage: string;
      voting_opens_at: string | null;
      ballot_cycle: number;
    }>(sql`
      SELECT current_stage, voting_opens_at, ballot_cycle
      FROM town.civic_processes
      WHERE id = ${input.processId}
      FOR UPDATE
    `);
    const row = rows.rows[0];
    if (!row?.voting_opens_at || row.current_stage !== 'ballot_preparation') {
      return;
    }
    if (new Date(row.voting_opens_at).getTime() > new Date(input.now).getTime()) {
      return;
    }
    const ballotCycle = row.ballot_cycle;

    const transitionResult = await tx.execute(sql`
      INSERT INTO town.civic_process_transitions (
        id, process_id, from_stage, to_stage, reason_key, occurred_at, ballot_cycle
      ) VALUES (
        gen_random_uuid(), ${input.processId}, 'ballot_preparation', 'voting',
        'ballot_prepared', ${input.now}, ${ballotCycle}
      )
      ON CONFLICT (process_id, from_stage, to_stage, ballot_cycle) DO NOTHING
    `);
    if (!transitionResult.rowCount) {
      return;
    }

    await tx.execute(
      sql`SELECT set_config('town.civic_stage_transition', 'ballot_prepared', true)`,
    );
    await tx.execute(sql`
      UPDATE town.civic_processes
      SET current_stage = 'voting', updated_at = ${input.now}
      WHERE id = ${input.processId} AND current_stage = 'ballot_preparation'
    `);
    await tx.execute(sql`SELECT set_config('town.civic_stage_transition', '', true)`);

    await tx.execute(sql`
      INSERT INTO town.civic_process_events (id, process_id, event_type, occurred_at, ballot_cycle)
      VALUES (
        gen_random_uuid(), ${input.processId}, 'stage_transitioned_to_voting', ${input.now}, ${ballotCycle}
      )
      ON CONFLICT (process_id, event_type, ballot_cycle) DO NOTHING
    `);

    // Mint one single-use cast token per eligible actor for this cycle
    // (§9): casting a vote consumes the token rather than linking the vote
    // row back to the actor.
    await tx.execute(sql`
      INSERT INTO town.civic_ballot_tokens (id, process_id, actor_id, ballot_cycle, issued_at)
      SELECT gen_random_uuid(), process_id, actor_id, ballot_cycle, ${input.now}
      FROM town.civic_ballot_eligible_actors
      WHERE process_id = ${input.processId} AND ballot_cycle = ${ballotCycle}
      ON CONFLICT (process_id, actor_id, ballot_cycle) DO NOTHING
    `);
  });
}

/**
 * Whether a given ballot cycle for this process ended in a quorum failure
 * (returned to deliberation instead of deciding a mandate) — used to report
 * an honest "quorum not reached" outcome even after the process has moved
 * on to a later cycle.
 */
export async function quorumFailedForBallotCycle(
  db: Db,
  input: { processId: string; ballotCycle: number },
): Promise<boolean> {
  const result = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM town.civic_process_events
      WHERE process_id = ${input.processId}
        AND event_type = 'stage_returned_to_deliberation_after_quorum_failure'
        AND ballot_cycle = ${input.ballotCycle}
    ) AS exists
  `);
  return result.rows[0]?.exists === true;
}

export async function listPublicCivicProcessEvents(
  db: Db,
  processId: string,
  limit = 50,
): Promise<PublicCivicProcessEvent[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 50));
  const result = await db.execute<{ event_type: string; occurred_at: string }>(sql`
    SELECT event_type, occurred_at
    FROM (
      SELECT event_type, occurred_at
      FROM town.civic_process_events
      WHERE process_id = ${processId}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${boundedLimit}
    ) recent
    ORDER BY occurred_at ASC
  `);
  return result.rows.map((row) => {
    if (
      row.event_type !== 'process_created' &&
      row.event_type !== 'stage_transitioned_to_proposals' &&
      row.event_type !== 'stage_transitioned_to_deliberation' &&
      row.event_type !== 'stage_transitioned_to_ballot_preparation' &&
      row.event_type !== 'stage_transitioned_to_voting' &&
      row.event_type !== 'stage_returned_to_deliberation_after_quorum_failure' &&
      row.event_type !== 'stage_transitioned_to_mandate' &&
      row.event_type !== 'stage_transitioned_to_action' &&
      row.event_type !== 'stage_transitioned_to_verification' &&
      row.event_type !== 'stage_transitioned_to_archived'
    ) {
      throw new Error('Unsupported public civic process event');
    }
    return { eventType: row.event_type, occurredAt: row.occurred_at };
  });
}
