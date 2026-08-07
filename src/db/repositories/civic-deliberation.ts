import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

type Db = Database['db'];

export type CivicDeliberationIntent =
  | 'observation'
  | 'proposal'
  | 'next_step'
  | 'argument_for'
  | 'risk_or_objection'
  | 'question'
  | 'author_response'
  | 'evidence'
  | 'amendment_suggestion'
  | 'minority_position';

export type CivicDeliberationContributionView = {
  id: string;
  processId: string;
  proposalId: string;
  authorActorId: string;
  authorDisplayName: string;
  intent: CivicDeliberationIntent;
  text: string;
  replyToContributionId: string | null;
  createdAt: string;
};

const SUPPORTED_INTENTS: readonly CivicDeliberationIntent[] = [
  'observation',
  'proposal',
  'next_step',
  'argument_for',
  'risk_or_objection',
  'question',
  'author_response',
  'evidence',
  'amendment_suggestion',
  'minority_position',
];

function toIntent(value: string): CivicDeliberationIntent {
  if (!(SUPPORTED_INTENTS as readonly string[]).includes(value)) {
    throw new Error('Unsupported civic deliberation contribution intent');
  }
  return value as CivicDeliberationIntent;
}

function toContributionView(row: {
  id: string;
  process_id: string;
  proposal_id: string;
  author_actor_id: string;
  author_display_name: string;
  intent: string;
  text: string;
  reply_to_contribution_id: string | null;
  created_at: string;
}): CivicDeliberationContributionView {
  return {
    id: row.id,
    processId: row.process_id,
    proposalId: row.proposal_id,
    authorActorId: row.author_actor_id,
    authorDisplayName: row.author_display_name,
    intent: toIntent(row.intent),
    text: row.text,
    replyToContributionId: row.reply_to_contribution_id,
    createdAt: row.created_at,
  };
}

export async function listCivicDeliberationContributionsForProcess(
  db: Db,
  processId: string,
  limit = 200,
): Promise<CivicDeliberationContributionView[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 200));
  const result = await db.execute<{
    id: string;
    process_id: string;
    proposal_id: string;
    author_actor_id: string;
    author_display_name: string;
    intent: string;
    text: string;
    reply_to_contribution_id: string | null;
    created_at: string;
  }>(sql`
    SELECT
      contribution.id,
      contribution.process_id,
      contribution.proposal_id,
      contribution.author_actor_id,
      actor.display_label AS author_display_name,
      contribution.intent,
      contribution.text,
      contribution.reply_to_contribution_id,
      contribution.created_at
    FROM town.civic_deliberation_contributions contribution
    JOIN town.actors actor ON actor.id = contribution.author_actor_id
    WHERE contribution.process_id = ${processId}
    ORDER BY contribution.created_at ASC, contribution.id ASC
    LIMIT ${boundedLimit}
  `);
  return result.rows.map(toContributionView);
}

/**
 * Minority positions (§7/§11): a dissenting view marked with the
 * `minority_position` intent is preserved verbatim in the mandate's
 * permanent record even after the majority proposal is selected — this is
 * not a separate voting mechanism, just a surfaced read of the same
 * deliberation contributions.
 */
export async function listMinorityPositionContributions(
  db: Db,
  processId: string,
): Promise<CivicDeliberationContributionView[]> {
  const result = await db.execute<{
    id: string;
    process_id: string;
    proposal_id: string;
    author_actor_id: string;
    author_display_name: string;
    intent: string;
    text: string;
    reply_to_contribution_id: string | null;
    created_at: string;
  }>(sql`
    SELECT
      contribution.id,
      contribution.process_id,
      contribution.proposal_id,
      contribution.author_actor_id,
      actor.display_label AS author_display_name,
      contribution.intent,
      contribution.text,
      contribution.reply_to_contribution_id,
      contribution.created_at
    FROM town.civic_deliberation_contributions contribution
    JOIN town.actors actor ON actor.id = contribution.author_actor_id
    WHERE contribution.process_id = ${processId} AND contribution.intent = 'minority_position'
    ORDER BY contribution.created_at ASC, contribution.id ASC
  `);
  return result.rows.map(toContributionView);
}

export async function insertCivicDeliberationContribution(
  db: Db,
  input: {
    id: string;
    processId: string;
    proposalId: string;
    actorId: string;
    intent: CivicDeliberationIntent;
    text: string;
    replyToContributionId: string | null;
    createdAt: string;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO town.civic_deliberation_contributions (
      id, process_id, proposal_id, author_actor_id, intent, text,
      reply_to_contribution_id, created_at
    ) VALUES (
      ${input.id}, ${input.processId}, ${input.proposalId}, ${input.actorId},
      ${input.intent}, ${input.text}, ${input.replyToContributionId}, ${input.createdAt}
    )
  `);
}

export async function countDistinctCivicDeliberationParticipants(
  db: Db,
  processId: string,
): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`
    SELECT count(DISTINCT author_actor_id)::text AS count
    FROM town.civic_deliberation_contributions
    WHERE process_id = ${processId}
  `);
  return Number(result.rows[0]?.count ?? 0);
}
