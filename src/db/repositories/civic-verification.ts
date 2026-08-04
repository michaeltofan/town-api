import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

type Db = Database['db'];

export type CivicVerificationEvidenceRow = {
  id: string;
  processId: string;
  authorActorId: string;
  authorDisplayName: string;
  text: string;
  url: string | null;
  createdAt: string;
};

export type CivicVerificationOutcome = 'delivered' | 'not_delivered';

export type CivicVerificationRow = {
  processId: string;
  outcome: CivicVerificationOutcome;
  deliveredCount: number;
  notDeliveredCount: number;
  decidedAt: string;
};

/**
 * Any active community actor can mark a decided action ready for
 * verification: there is no threshold, just a deliberate step by one
 * eligible actor. Row-locked and idempotent, so concurrent callers race
 * safely and a stage that already moved on is simply a no-op.
 */
export async function markActionReadyForVerification(
  db: Db,
  input: { processId: string; now: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.execute<{ current_stage: string }>(sql`
      SELECT current_stage
      FROM town.civic_processes
      WHERE id = ${input.processId}
      FOR UPDATE
    `);
    const row = rows.rows[0];
    if (row?.current_stage !== 'action') {
      return;
    }

    const transitionResult = await tx.execute(sql`
      INSERT INTO town.civic_process_transitions (
        id, process_id, from_stage, to_stage, reason_key, occurred_at
      ) VALUES (
        gen_random_uuid(), ${input.processId}, 'action', 'verification', 'action_marked_ready',
        ${input.now}
      )
      ON CONFLICT (process_id, from_stage, to_stage) DO NOTHING
    `);
    if (!transitionResult.rowCount) {
      return;
    }

    await tx.execute(
      sql`SELECT set_config('town.civic_stage_transition', 'action_marked_ready', true)`,
    );
    await tx.execute(sql`
      UPDATE town.civic_processes
      SET current_stage = 'verification', updated_at = ${input.now}
      WHERE id = ${input.processId} AND current_stage = 'action'
    `);
    await tx.execute(sql`SELECT set_config('town.civic_stage_transition', '', true)`);

    await tx.execute(sql`
      INSERT INTO town.civic_process_events (id, process_id, event_type, occurred_at)
      VALUES (gen_random_uuid(), ${input.processId}, 'stage_transitioned_to_verification', ${input.now})
      ON CONFLICT (process_id, event_type) DO NOTHING
    `);
  });
}

export async function insertCivicVerificationEvidence(
  db: Db,
  input: {
    id: string;
    processId: string;
    actorId: string;
    text: string;
    url: string | null;
    createdAt: string;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO town.civic_verification_evidence (id, process_id, author_actor_id, text, url, created_at)
    VALUES (
      ${input.id}, ${input.processId}, ${input.actorId}, ${input.text}, ${input.url}, ${input.createdAt}
    )
  `);
}

export async function listCivicVerificationEvidenceForProcess(
  db: Db,
  processId: string,
  limit = 200,
): Promise<CivicVerificationEvidenceRow[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 200));
  const result = await db.execute<{
    id: string;
    process_id: string;
    author_actor_id: string;
    author_display_name: string;
    text: string;
    url: string | null;
    created_at: string;
  }>(sql`
    SELECT
      evidence.id,
      evidence.process_id,
      evidence.author_actor_id,
      actor.display_label AS author_display_name,
      evidence.text,
      evidence.url,
      evidence.created_at
    FROM town.civic_verification_evidence evidence
    JOIN town.actors actor ON actor.id = evidence.author_actor_id
    WHERE evidence.process_id = ${processId}
    ORDER BY evidence.created_at, evidence.id
    LIMIT ${boundedLimit}
  `);
  return result.rows.map((row) => ({
    id: row.id,
    processId: row.process_id,
    authorActorId: row.author_actor_id,
    authorDisplayName: row.author_display_name,
    text: row.text,
    url: row.url,
    createdAt: row.created_at,
  }));
}

export async function findCivicVerificationConfirmationByProcessAndActor(
  db: Db,
  input: { processId: string; actorId: string },
): Promise<{ outcome: CivicVerificationOutcome } | null> {
  const result = await db.execute<{ outcome: string }>(sql`
    SELECT outcome
    FROM town.civic_verification_confirmations
    WHERE process_id = ${input.processId}
      AND actor_id = ${input.actorId}
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  if (row.outcome !== 'delivered' && row.outcome !== 'not_delivered') {
    throw new Error('Unsupported civic verification confirmation outcome');
  }
  return { outcome: row.outcome };
}

export async function insertCivicVerificationConfirmation(
  db: Db,
  input: {
    id: string;
    processId: string;
    actorId: string;
    outcome: CivicVerificationOutcome;
    createdAt: string;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO town.civic_verification_confirmations (id, process_id, actor_id, outcome, created_at)
    VALUES (${input.id}, ${input.processId}, ${input.actorId}, ${input.outcome}, ${input.createdAt})
  `);
}

export async function listCivicVerificationConfirmationTallyForProcess(
  db: Db,
  processId: string,
): Promise<{ deliveredCount: number; notDeliveredCount: number }> {
  const result = await db.execute<{ delivered_count: string; not_delivered_count: string }>(sql`
    SELECT
      count(*) FILTER (WHERE outcome = 'delivered')::text AS delivered_count,
      count(*) FILTER (WHERE outcome = 'not_delivered')::text AS not_delivered_count
    FROM town.civic_verification_confirmations
    WHERE process_id = ${processId}
  `);
  const row = result.rows[0];
  return {
    deliveredCount: Number(row?.delivered_count ?? 0),
    notDeliveredCount: Number(row?.not_delivered_count ?? 0),
  };
}

export async function findCivicVerification(
  db: Db,
  processId: string,
): Promise<CivicVerificationRow | null> {
  const result = await db.execute<{
    process_id: string;
    outcome: string;
    delivered_count: number;
    not_delivered_count: number;
    decided_at: string;
  }>(sql`
    SELECT process_id, outcome, delivered_count, not_delivered_count, decided_at
    FROM town.civic_verifications
    WHERE process_id = ${processId}
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  if (row.outcome !== 'delivered' && row.outcome !== 'not_delivered') {
    throw new Error('Unsupported civic verification outcome');
  }
  return {
    processId: row.process_id,
    outcome: row.outcome,
    deliveredCount: row.delivered_count,
    notDeliveredCount: row.not_delivered_count,
    decidedAt: row.decided_at,
  };
}
