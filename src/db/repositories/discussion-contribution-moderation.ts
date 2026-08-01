import { eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  signalDiscussionContributions,
  type SignalDiscussionContributionRow,
  type SignalHideReason,
} from '../schema.js';

type Db = Database['db'];

export async function lockDiscussionContributionById(
  db: Db,
  contributionId: string,
): Promise<SignalDiscussionContributionRow | null> {
  const rows = await db
    .select()
    .from(signalDiscussionContributions)
    .where(eq(signalDiscussionContributions.id, contributionId))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

export type HideDiscussionContributionResult = {
  contribution: SignalDiscussionContributionRow;
  changed: boolean;
};

/**
 * Hide a discussion contribution. Idempotent: already-hidden rows keep who/when/why.
 */
export async function hideDiscussionContribution(
  db: Db,
  input: {
    contributionId: string;
    reason: SignalHideReason;
    hiddenByAccountId: string;
    at: string;
  },
): Promise<HideDiscussionContributionResult | null> {
  const locked = await lockDiscussionContributionById(db, input.contributionId);
  if (!locked) {
    return null;
  }
  if (locked.hiddenAt !== null) {
    return { contribution: locked, changed: false };
  }

  const rows = await db
    .update(signalDiscussionContributions)
    .set({
      hiddenAt: input.at,
      hiddenReason: input.reason,
      hiddenByAccountId: input.hiddenByAccountId,
    })
    .where(eq(signalDiscussionContributions.id, locked.id))
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to hide discussion contribution');
  }
  return { contribution: row, changed: true };
}

export type UnhideDiscussionContributionResult = {
  contribution: SignalDiscussionContributionRow;
  changed: boolean;
};

/**
 * Unhide a discussion contribution. Idempotent when already visible.
 */
export async function unhideDiscussionContribution(
  db: Db,
  input: { contributionId: string },
): Promise<UnhideDiscussionContributionResult | null> {
  const locked = await lockDiscussionContributionById(db, input.contributionId);
  if (!locked) {
    return null;
  }
  if (locked.hiddenAt === null) {
    return { contribution: locked, changed: false };
  }

  const rows = await db
    .update(signalDiscussionContributions)
    .set({
      hiddenAt: null,
      hiddenReason: null,
      hiddenByAccountId: null,
    })
    .where(eq(signalDiscussionContributions.id, locked.id))
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to unhide discussion contribution');
  }
  return { contribution: row, changed: true };
}
