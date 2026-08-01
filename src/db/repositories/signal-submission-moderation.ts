import { eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  signalSubmissions,
  type SignalHideReason,
  type SignalSubmissionRow,
} from '../schema.js';

type Db = Database['db'];

export async function lockSignalSubmissionById(
  db: Db,
  submissionId: string,
): Promise<SignalSubmissionRow | null> {
  const rows = await db
    .select()
    .from(signalSubmissions)
    .where(eq(signalSubmissions.id, submissionId))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

export async function findSignalSubmissionById(
  db: Db,
  submissionId: string,
): Promise<SignalSubmissionRow | null> {
  const rows = await db
    .select()
    .from(signalSubmissions)
    .where(eq(signalSubmissions.id, submissionId))
    .limit(1);
  return rows[0] ?? null;
}

export type RejectSignalSubmissionResult = {
  submission: SignalSubmissionRow;
  changed: boolean;
};

/**
 * Reject a pending submission. Idempotent when already rejected with same reason
 * ownership retained (changed=false, no overwrite of prior reviewer/reason/time).
 */
export async function rejectSignalSubmission(
  db: Db,
  input: {
    submissionId: string;
    reason: SignalHideReason;
    reviewedByAccountId: string;
    at: string;
  },
): Promise<RejectSignalSubmissionResult | null> {
  const locked = await lockSignalSubmissionById(db, input.submissionId);
  if (!locked) {
    return null;
  }
  if (locked.status === 'rejected') {
    return { submission: locked, changed: false };
  }
  if (locked.status !== 'pending_review') {
    return { submission: locked, changed: false };
  }

  const rows = await db
    .update(signalSubmissions)
    .set({
      status: 'rejected',
      reviewedAt: input.at,
      reviewedByAccountId: input.reviewedByAccountId,
      reviewReason: input.reason,
      updatedAt: input.at,
    })
    .where(eq(signalSubmissions.id, locked.id))
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to reject signal submission');
  }
  return { submission: row, changed: true };
}

export type RestoreSignalSubmissionResult = {
  submission: SignalSubmissionRow;
  changed: boolean;
};

/**
 * Restore a rejected submission to pending_review. Idempotent when already pending.
 */
export async function restoreSignalSubmission(
  db: Db,
  input: { submissionId: string; at: string },
): Promise<RestoreSignalSubmissionResult | null> {
  const locked = await lockSignalSubmissionById(db, input.submissionId);
  if (!locked) {
    return null;
  }
  if (locked.status === 'pending_review') {
    return { submission: locked, changed: false };
  }
  if (locked.status !== 'rejected') {
    return { submission: locked, changed: false };
  }

  const rows = await db
    .update(signalSubmissions)
    .set({
      status: 'pending_review',
      reviewedAt: null,
      reviewedByAccountId: null,
      reviewReason: null,
      updatedAt: input.at,
    })
    .where(eq(signalSubmissions.id, locked.id))
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to restore signal submission');
  }
  return { submission: row, changed: true };
}
