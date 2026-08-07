import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

type Db = Database['db'];

export type CivicVoteTallyRow = {
  proposalId: string;
  voteCount: number;
};

export type CivicBallotTokenStatus = 'not_eligible' | 'not_voted' | 'already_voted';

/**
 * Whether this actor has cast a vote this ballot cycle — derived from token
 * consumption, never from the vote row itself (§9: civic_votes carries no
 * link back to the actor, so "what did I vote?" cannot be answered once
 * cast, only "have I voted?").
 */
export async function findCivicBallotTokenStatus(
  db: Db,
  input: { processId: string; actorId: string; ballotCycle: number },
): Promise<CivicBallotTokenStatus> {
  const result = await db.execute<{ consumed_at: string | null }>(sql`
    SELECT consumed_at
    FROM town.civic_ballot_tokens
    WHERE process_id = ${input.processId}
      AND actor_id = ${input.actorId}
      AND ballot_cycle = ${input.ballotCycle}
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return 'not_eligible';
  return row.consumed_at !== null ? 'already_voted' : 'not_voted';
}

export async function listCivicVoteTallyForProcess(
  db: Db,
  input: { processId: string; ballotCycle: number },
): Promise<CivicVoteTallyRow[]> {
  const result = await db.execute<{ proposal_id: string; vote_count: string }>(sql`
    SELECT proposal_id, count(*)::text AS vote_count
    FROM town.civic_votes
    WHERE process_id = ${input.processId} AND ballot_cycle = ${input.ballotCycle}
    GROUP BY proposal_id
  `);
  return result.rows.map((row) => ({
    proposalId: row.proposal_id,
    voteCount: Number(row.vote_count),
  }));
}

export async function countCivicVotesForProcess(
  db: Db,
  input: { processId: string; ballotCycle: number },
): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count
    FROM town.civic_votes
    WHERE process_id = ${input.processId} AND ballot_cycle = ${input.ballotCycle}
  `);
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Casts one vote by consuming the caller's single-use ballot token and
 * writing the choice into civic_votes, in one atomic statement (§9). The
 * UPDATE ... WHERE consumed_at IS NULL clause is itself the race-safe
 * eligibility and one-vote-per-actor guard: a concurrent double-submit
 * simply finds the token already consumed and affects zero rows. Returns
 * false when no unconsumed token existed for this actor and cycle (not
 * eligible, or already voted) — the caller re-checks findCivicBallotTokenStatus
 * to report a precise reason.
 */
export async function castCivicVote(
  db: Db,
  input: {
    id: string;
    processId: string;
    proposalId: string;
    actorId: string;
    ballotCycle: number;
    castAt: string;
  },
): Promise<boolean> {
  const result = await db.execute(sql`
    WITH consumed AS (
      UPDATE town.civic_ballot_tokens
      SET consumed_at = ${input.castAt}
      WHERE process_id = ${input.processId}
        AND actor_id = ${input.actorId}
        AND ballot_cycle = ${input.ballotCycle}
        AND consumed_at IS NULL
      RETURNING id
    )
    INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
    SELECT ${input.id}, ${input.processId}, ${input.proposalId}, ${input.ballotCycle}, ${input.castAt}
    FROM consumed
    RETURNING id
  `);
  return (result.rowCount ?? 0) > 0;
}
