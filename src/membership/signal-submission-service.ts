import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import type { ActorRow, CommunityRow } from '../db/schema.js';
import {
  countAccountSignalSubmissionsSince,
  insertSignalSubmission,
  rollingWindowStartIso,
  SIGNAL_SUBMISSION_ACCOUNT_LIMIT_24H,
} from '../db/repositories/signal-submissions.js';
import { rateLimitedError } from '../errors/app-error.js';
import { lockAccountById } from '../identity/repositories/accounts.js';
import { toIsoTimestamp } from '../lib/timestamps.js';

type Db = Database['db'];

export type CreateSignalSubmissionResult = {
  id: string;
  status: 'pending_review';
  community: { slug: string };
  createdAt: string;
};

/**
 * Create a pending signal submission inside a caller-provided transaction.
 * Locks the account row, enforces the rolling 24h account submission cap, then inserts.
 */
export async function createSignalSubmissionInTransaction(
  db: Db,
  input: {
    accountId: string;
    actor: Pick<ActorRow, 'id'>;
    community: Pick<CommunityRow, 'id' | 'slug'>;
    headline: string;
    body: string;
    now: string;
    generateId?: () => string;
  },
): Promise<CreateSignalSubmissionResult> {
  const locked = await lockAccountById(db, input.accountId);
  if (!locked) {
    throw new Error('Signal submission requires an existing account');
  }

  const since = rollingWindowStartIso(input.now);
  const existing = await countAccountSignalSubmissionsSince(db, {
    accountId: input.accountId,
    since,
  });
  if (existing >= SIGNAL_SUBMISSION_ACCOUNT_LIMIT_24H) {
    throw rateLimitedError();
  }

  const id = (input.generateId ?? (() => randomUUID()))();
  const row = await insertSignalSubmission(db, {
    id,
    accountId: input.accountId,
    actorId: input.actor.id,
    communityId: input.community.id,
    headline: input.headline,
    body: input.body,
    createdAt: input.now,
    updatedAt: input.now,
  });

  return {
    id: row.id,
    status: 'pending_review',
    community: { slug: input.community.slug },
    createdAt: toIsoTimestamp(row.createdAt),
  };
}
