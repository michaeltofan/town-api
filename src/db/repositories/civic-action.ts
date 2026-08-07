import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

type Db = Database['db'];

export type CivicActionUpdateKind =
  'status_update' | 'take_step' | 'offer_help' | 'evidence' | 'institution_response';

export type CivicActionBlockedReasonKey =
  'awaiting_institution_response' | 'awaiting_resources' | 'awaiting_volunteers' | 'other';

export type CivicActionUpdateRow = {
  id: string;
  processId: string;
  authorActorId: string;
  authorDisplayName: string;
  text: string;
  kind: CivicActionUpdateKind;
  blockedReasonKey: CivicActionBlockedReasonKey | null;
  url: string | null;
  createdAt: string;
};

const SUPPORTED_KINDS: readonly CivicActionUpdateKind[] = [
  'status_update',
  'take_step',
  'offer_help',
  'evidence',
  'institution_response',
];

function toKind(value: string): CivicActionUpdateKind {
  if (!(SUPPORTED_KINDS as readonly string[]).includes(value)) {
    throw new Error('Unsupported civic action update kind');
  }
  return value as CivicActionUpdateKind;
}

function toBlockedReasonKey(value: string | null): CivicActionBlockedReasonKey | null {
  if (value === null) return null;
  if (
    value !== 'awaiting_institution_response' &&
    value !== 'awaiting_resources' &&
    value !== 'awaiting_volunteers' &&
    value !== 'other'
  ) {
    throw new Error('Unsupported civic action blocked reason key');
  }
  return value;
}

function toUpdateRow(row: {
  id: string;
  process_id: string;
  author_actor_id: string;
  author_display_name: string;
  text: string;
  kind: string;
  blocked_reason_key: string | null;
  url: string | null;
  created_at: string;
}): CivicActionUpdateRow {
  return {
    id: row.id,
    processId: row.process_id,
    authorActorId: row.author_actor_id,
    authorDisplayName: row.author_display_name,
    text: row.text,
    kind: toKind(row.kind),
    blockedReasonKey: toBlockedReasonKey(row.blocked_reason_key),
    url: row.url,
    createdAt: row.created_at,
  };
}

export async function insertCivicActionUpdate(
  db: Db,
  input: {
    id: string;
    processId: string;
    actorId: string;
    text: string;
    kind: CivicActionUpdateKind;
    blockedReasonKey: CivicActionBlockedReasonKey | null;
    url: string | null;
    createdAt: string;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO town.civic_action_updates (
      id, process_id, author_actor_id, text, kind, blocked_reason_key, url, created_at
    ) VALUES (
      ${input.id}, ${input.processId}, ${input.actorId}, ${input.text}, ${input.kind},
      ${input.blockedReasonKey}, ${input.url}, ${input.createdAt}
    )
  `);
}

export async function listCivicActionUpdatesForProcess(
  db: Db,
  processId: string,
  limit = 200,
): Promise<CivicActionUpdateRow[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 200));
  const result = await db.execute<{
    id: string;
    process_id: string;
    author_actor_id: string;
    author_display_name: string;
    text: string;
    kind: string;
    blocked_reason_key: string | null;
    url: string | null;
    created_at: string;
  }>(sql`
    SELECT
      update.id,
      update.process_id,
      update.author_actor_id,
      actor.display_label AS author_display_name,
      update.text,
      update.kind,
      update.blocked_reason_key,
      update.url,
      update.created_at
    FROM town.civic_action_updates update
    JOIN town.actors actor ON actor.id = update.author_actor_id
    WHERE update.process_id = ${processId}
    ORDER BY update.created_at, update.id
    LIMIT ${boundedLimit}
  `);
  return result.rows.map(toUpdateRow);
}

/**
 * "Named responsible actor" (§12) is never a separately stored assignment —
 * it is the actor who posted the process's one-and-only take_step update, a
 * partial-unique-indexed claim (first wins, immutable), read the same way
 * every other derived state in this schema is read.
 */
export async function findCivicActionResponsibleActor(
  db: Db,
  processId: string,
): Promise<{ actorId: string; displayName: string } | null> {
  const result = await db.execute<{ actor_id: string; display_name: string }>(sql`
    SELECT update.author_actor_id AS actor_id, actor.display_label AS display_name
    FROM town.civic_action_updates update
    JOIN town.actors actor ON actor.id = update.author_actor_id
    WHERE update.process_id = ${processId} AND update.kind = 'take_step'
    LIMIT 1
  `);
  const row = result.rows[0];
  return row ? { actorId: row.actor_id, displayName: row.display_name } : null;
}

/** Optional collaborators (§12): every distinct actor who ever offered help. */
export async function listCivicActionCollaborators(
  db: Db,
  processId: string,
): Promise<{ actorId: string; displayName: string }[]> {
  const result = await db.execute<{ actor_id: string; display_name: string }>(sql`
    SELECT DISTINCT ON (update.author_actor_id)
      update.author_actor_id AS actor_id, actor.display_label AS display_name
    FROM town.civic_action_updates update
    JOIN town.actors actor ON actor.id = update.author_actor_id
    WHERE update.process_id = ${processId} AND update.kind = 'offer_help'
    ORDER BY update.author_actor_id, update.created_at
  `);
  return result.rows.map((row) => ({ actorId: row.actor_id, displayName: row.display_name }));
}
