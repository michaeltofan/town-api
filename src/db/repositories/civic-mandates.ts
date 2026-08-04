import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

type Db = Database['db'];

export type CivicMandateRow = {
  processId: string;
  proposalId: string | null;
  voteCount: number;
  totalVotes: number;
  decidedAt: string;
};

export async function findCivicMandate(db: Db, processId: string): Promise<CivicMandateRow | null> {
  const result = await db.execute<{
    process_id: string;
    proposal_id: string | null;
    vote_count: number;
    total_votes: number;
    decided_at: string;
  }>(sql`
    SELECT process_id, proposal_id, vote_count, total_votes, decided_at
    FROM town.civic_mandates
    WHERE process_id = ${processId}
    LIMIT 1
  `);
  const row = result.rows[0];
  return row
    ? {
        processId: row.process_id,
        proposalId: row.proposal_id,
        voteCount: row.vote_count,
        totalVotes: row.total_votes,
        decidedAt: row.decided_at,
      }
    : null;
}

/**
 * There is no scheduled job: the voting window is only ever closed lazily,
 * the moment any request touches a process whose voting_closes_at has
 * passed. Row-locked and idempotent, so concurrent requests race safely.
 */
export async function closeVotingWindowIfElapsed(
  db: Db,
  input: { processId: string; now: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.execute<{
      current_stage: string;
      voting_closes_at: string | null;
    }>(sql`
      SELECT current_stage, voting_closes_at
      FROM town.civic_processes
      WHERE id = ${input.processId}
      FOR UPDATE
    `);
    const row = rows.rows[0];
    if (!row?.voting_closes_at || row.current_stage !== 'voting') {
      return;
    }
    if (new Date(row.voting_closes_at).getTime() > new Date(input.now).getTime()) {
      return;
    }

    const tally = await tx.execute<{ proposal_id: string; vote_count: string }>(sql`
      SELECT proposal_id, count(*)::text AS vote_count
      FROM town.civic_votes
      WHERE process_id = ${input.processId}
      GROUP BY proposal_id
      ORDER BY count(*) DESC
    `);
    const totalVotes = tally.rows.reduce((sum, r) => sum + Number(r.vote_count), 0);
    const top = tally.rows[0];
    const topCount = top ? Number(top.vote_count) : 0;
    const tiedAtTop = tally.rows.filter((r) => Number(r.vote_count) === topCount).length;
    const winnerProposalId = top && tiedAtTop === 1 ? top.proposal_id : null;

    const transitionResult = await tx.execute(sql`
      INSERT INTO town.civic_process_transitions (
        id, process_id, from_stage, to_stage, reason_key, occurred_at
      ) VALUES (
        gen_random_uuid(), ${input.processId}, 'voting', 'mandate', 'voting_window_closed', ${input.now}
      )
      ON CONFLICT (process_id, from_stage, to_stage) DO NOTHING
    `);
    if (!transitionResult.rowCount) {
      return;
    }

    await tx.execute(
      sql`SELECT set_config('town.civic_stage_transition', 'voting_window_closed', true)`,
    );
    await tx.execute(sql`
      UPDATE town.civic_processes
      SET current_stage = 'mandate', updated_at = ${input.now}
      WHERE id = ${input.processId} AND current_stage = 'voting'
    `);
    await tx.execute(sql`SELECT set_config('town.civic_stage_transition', '', true)`);

    await tx.execute(sql`
      INSERT INTO town.civic_process_events (id, process_id, event_type, occurred_at)
      VALUES (gen_random_uuid(), ${input.processId}, 'stage_transitioned_to_mandate', ${input.now})
      ON CONFLICT (process_id, event_type) DO NOTHING
    `);

    await tx.execute(sql`
      INSERT INTO town.civic_mandates (process_id, proposal_id, vote_count, total_votes, decided_at)
      VALUES (${input.processId}, ${winnerProposalId}, ${topCount}, ${totalVotes}, ${input.now})
      ON CONFLICT (process_id) DO NOTHING
    `);

    if (!winnerProposalId) {
      return;
    }

    // A decided mandate (a single, undisputed winner) opens action in the
    // same transaction: there is no waiting period, mirroring how
    // ballot_preparation opens voting immediately once the ballot is final.
    // A contested mandate (a tie, no winner) stays parked at mandate.
    // Recorded a microsecond after the mandate so the two events keep a
    // well-defined, causally accurate order in the public timeline instead
    // of tying on an identical timestamp.
    const actionTransitionResult = await tx.execute(sql`
      INSERT INTO town.civic_process_transitions (
        id, process_id, from_stage, to_stage, reason_key, occurred_at
      ) VALUES (
        gen_random_uuid(), ${input.processId}, 'mandate', 'action', 'mandate_decided',
        ${input.now}::timestamptz + interval '1 microsecond'
      )
      ON CONFLICT (process_id, from_stage, to_stage) DO NOTHING
    `);
    if (!actionTransitionResult.rowCount) {
      return;
    }

    await tx.execute(
      sql`SELECT set_config('town.civic_stage_transition', 'mandate_decided', true)`,
    );
    await tx.execute(sql`
      UPDATE town.civic_processes
      SET
        current_stage = 'action',
        updated_at = ${input.now}::timestamptz + interval '1 microsecond'
      WHERE id = ${input.processId} AND current_stage = 'mandate'
    `);
    await tx.execute(sql`SELECT set_config('town.civic_stage_transition', '', true)`);

    await tx.execute(sql`
      INSERT INTO town.civic_process_events (id, process_id, event_type, occurred_at)
      VALUES (
        gen_random_uuid(), ${input.processId}, 'stage_transitioned_to_action',
        ${input.now}::timestamptz + interval '1 microsecond'
      )
      ON CONFLICT (process_id, event_type) DO NOTHING
    `);
  });
}
