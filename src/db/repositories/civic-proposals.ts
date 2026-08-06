import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

type Db = Database['db'];

export type CivicProposalLifecycleState = 'published' | 'revised' | 'withdrawn';

export type CivicProposalView = {
  id: string;
  processId: string;
  authorActorId: string;
  authorDisplayName: string;
  title: string;
  body: string;
  targetInstitution: string | null;
  expectedOutcome: string | null;
  estimatedResources: string | null;
  indicativeDeadline: string | null;
  lifecycleState: CivicProposalLifecycleState;
  revisedAt: string | null;
  withdrawnAt: string | null;
  createdAt: string;
};

type CivicProposalRow = {
  id: string;
  process_id: string;
  author_actor_id: string;
  author_display_name: string;
  title: string;
  body: string;
  target_institution: string | null;
  expected_outcome: string | null;
  estimated_resources: string | null;
  indicative_deadline: string | null;
  lifecycle_state: string;
  revised_at: string | null;
  withdrawn_at: string | null;
  created_at: string;
};

function toLifecycleState(value: string): CivicProposalLifecycleState {
  if (value !== 'published' && value !== 'revised' && value !== 'withdrawn') {
    throw new Error('Unsupported civic proposal lifecycle state');
  }
  return value;
}

function toView(row: CivicProposalRow): CivicProposalView {
  return {
    id: row.id,
    processId: row.process_id,
    authorActorId: row.author_actor_id,
    authorDisplayName: row.author_display_name,
    title: row.title,
    body: row.body,
    targetInstitution: row.target_institution,
    expectedOutcome: row.expected_outcome,
    estimatedResources: row.estimated_resources,
    indicativeDeadline: row.indicative_deadline,
    lifecycleState: toLifecycleState(row.lifecycle_state),
    revisedAt: row.revised_at,
    withdrawnAt: row.withdrawn_at,
    createdAt: row.created_at,
  };
}

const PROPOSAL_SELECT = sql`
  SELECT
    proposal.id,
    proposal.process_id,
    proposal.author_actor_id,
    actor.display_label AS author_display_name,
    proposal.title,
    proposal.body,
    proposal.target_institution,
    proposal.expected_outcome,
    proposal.estimated_resources,
    proposal.indicative_deadline::text AS indicative_deadline,
    proposal.lifecycle_state,
    proposal.revised_at,
    proposal.withdrawn_at,
    proposal.created_at
  FROM town.civic_proposals proposal
  JOIN town.actors actor ON actor.id = proposal.author_actor_id
`;

export async function countCivicProposalsForProcess(db: Db, processId: string): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count
    FROM town.civic_proposals
    WHERE process_id = ${processId}
  `);
  return Number(result.rows[0]?.count ?? 0);
}

export async function listCivicProposals(
  db: Db,
  processId: string,
  limit = 100,
): Promise<CivicProposalView[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const result = await db.execute<CivicProposalRow>(sql`
    ${PROPOSAL_SELECT}
    WHERE proposal.process_id = ${processId}
    ORDER BY proposal.created_at ASC, proposal.id ASC
    LIMIT ${boundedLimit}
  `);
  return result.rows.map(toView);
}

export async function findCivicProposalByProcessAndActor(
  db: Db,
  input: { processId: string; actorId: string },
): Promise<CivicProposalView | null> {
  const proposals = await db.execute<CivicProposalRow>(sql`
    ${PROPOSAL_SELECT}
    WHERE proposal.process_id = ${input.processId}
      AND proposal.author_actor_id = ${input.actorId}
    LIMIT 1
  `);
  const row = proposals.rows[0];
  return row ? toView(row) : null;
}

export async function findCivicProposalById(
  db: Db,
  proposalId: string,
): Promise<CivicProposalView | null> {
  const proposals = await db.execute<CivicProposalRow>(sql`
    ${PROPOSAL_SELECT}
    WHERE proposal.id = ${proposalId}
    LIMIT 1
  `);
  const row = proposals.rows[0];
  return row ? toView(row) : null;
}

export async function insertCivicProposal(
  db: Db,
  input: {
    id: string;
    processId: string;
    actorId: string;
    title: string;
    body: string;
    targetInstitution: string | null;
    expectedOutcome: string | null;
    estimatedResources: string | null;
    indicativeDeadline: string | null;
    createdAt: string;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO town.civic_proposals (
      id, process_id, author_actor_id, title, body,
      target_institution, expected_outcome, estimated_resources, indicative_deadline,
      created_at
    ) VALUES (
      ${input.id}, ${input.processId}, ${input.actorId},
      ${input.title}, ${input.body},
      ${input.targetInstitution}, ${input.expectedOutcome}, ${input.estimatedResources},
      ${input.indicativeDeadline}, ${input.createdAt}
    )
  `);
}

export type CivicProposalReviseError = 'not_found' | 'not_author' | 'db_rejected';

/**
 * Revises a proposal's content exactly once. The DB trigger
 * (`guard_civic_proposal_update`) is the source of truth for "exactly once,
 * only from published, only while proposals is open" — this only adds the
 * ownership check the trigger cannot see (it has no actor identity to
 * compare against a caller).
 */
export async function reviseCivicProposal(
  db: Db,
  input: {
    proposalId: string;
    actorId: string;
    title: string;
    body: string;
    targetInstitution: string | null;
    expectedOutcome: string | null;
    estimatedResources: string | null;
    indicativeDeadline: string | null;
  },
): Promise<CivicProposalReviseError | null> {
  const existing = await db.execute<{ author_actor_id: string }>(sql`
    SELECT author_actor_id FROM town.civic_proposals WHERE id = ${input.proposalId} LIMIT 1
  `);
  const row = existing.rows[0];
  if (!row) return 'not_found';
  if (row.author_actor_id !== input.actorId) return 'not_author';
  try {
    await db.execute(sql`
      UPDATE town.civic_proposals
      SET title = ${input.title},
          body = ${input.body},
          target_institution = ${input.targetInstitution},
          expected_outcome = ${input.expectedOutcome},
          estimated_resources = ${input.estimatedResources},
          indicative_deadline = ${input.indicativeDeadline}
      WHERE id = ${input.proposalId}
    `);
    return null;
  } catch {
    return 'db_rejected';
  }
}

export type CivicProposalWithdrawError = 'not_found' | 'not_author' | 'db_rejected';

export async function withdrawCivicProposal(
  db: Db,
  input: { proposalId: string; actorId: string; withdrawnAt: string },
): Promise<CivicProposalWithdrawError | null> {
  const existing = await db.execute<{ author_actor_id: string }>(sql`
    SELECT author_actor_id FROM town.civic_proposals WHERE id = ${input.proposalId} LIMIT 1
  `);
  const row = existing.rows[0];
  if (!row) return 'not_found';
  if (row.author_actor_id !== input.actorId) return 'not_author';
  try {
    await db.execute(sql`
      UPDATE town.civic_proposals
      SET lifecycle_state = 'withdrawn', withdrawn_at = ${input.withdrawnAt}
      WHERE id = ${input.proposalId}
    `);
    return null;
  } catch {
    return 'db_rejected';
  }
}
