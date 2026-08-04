import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

type Db = Database['db'];

export const CIVIC_CONFIRMATION_THRESHOLD = 5;
export const CIVIC_PROPOSAL_THRESHOLD = 5;
export const CIVIC_DELIBERATION_THRESHOLD = 5;

export type PublicCivicProcessStage =
  'confirmation' | 'proposals' | 'deliberation' | 'ballot_preparation' | 'voting';

export type CivicProcessReadRow = {
  id: string;
  signalId: string;
  communityId: string;
  currentStage: PublicCivicProcessStage;
  createdAt: string;
  updatedAt: string;
};

export type PublicCivicProcessEvent = {
  eventType:
    | 'process_created'
    | 'stage_transitioned_to_proposals'
    | 'stage_transitioned_to_deliberation'
    | 'stage_transitioned_to_ballot_preparation'
    | 'stage_transitioned_to_voting';
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
    created_at: string;
    updated_at: string;
  }>(sql`
    SELECT id, signal_id, community_id, current_stage, created_at, updated_at
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
    row.current_stage !== 'voting'
  ) {
    throw new Error('Unsupported civic process stage');
  }
  return {
    id: row.id,
    signalId: row.signal_id,
    communityId: row.community_id,
    currentStage: row.current_stage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
      row.event_type !== 'stage_transitioned_to_voting'
    ) {
      throw new Error('Unsupported public civic process event');
    }
    return { eventType: row.event_type, occurredAt: row.occurred_at };
  });
}
