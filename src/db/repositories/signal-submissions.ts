import { and, count, eq, gte } from 'drizzle-orm';
import type { Database } from '../client.js';
import { signalSubmissions, type SignalSubmissionRow } from '../schema.js';

type Db = Database['db'];

const WINDOW_24H_MS = 24 * 60 * 60_000;

export async function countAccountSignalSubmissionsSince(
  db: Db,
  input: { accountId: string; since: string },
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(signalSubmissions)
    .where(
      and(
        eq(signalSubmissions.accountId, input.accountId),
        gte(signalSubmissions.createdAt, input.since),
      ),
    );
  return rows[0]?.value ?? 0;
}

export async function insertSignalSubmission(
  db: Db,
  input: {
    id: string;
    accountId: string;
    actorId: string;
    communityId: string;
    headline: string;
    body: string;
    createdAt: string;
    updatedAt: string;
  },
): Promise<SignalSubmissionRow> {
  const inserted = await db
    .insert(signalSubmissions)
    .values({
      id: input.id,
      accountId: input.accountId,
      actorId: input.actorId,
      communityId: input.communityId,
      headline: input.headline,
      body: input.body,
      status: 'pending_review',
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    })
    .returning();
  const row = inserted[0];
  if (!row) {
    throw new Error('Failed to insert signal submission');
  }
  return row;
}

export function rollingWindowStartIso(nowIso: string, windowMs = WINDOW_24H_MS): string {
  return new Date(new Date(nowIso).getTime() - windowMs).toISOString();
}

export const SIGNAL_SUBMISSION_ACCOUNT_LIMIT_24H = 5;
