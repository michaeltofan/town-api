import type { Database } from '../db/client.js';
import type { MembershipSource } from '../db/schema.js';
import { findExpiredMembershipCandidates } from './repositories/entitlements.js';
import { expireMembership } from './transitions/expire.js';
import type { MembershipTransitionOutcome } from './transitions/shared.js';

type Db = Database['db'];

export type ReconcileExpiredMembershipsInput = {
  now: string;
  batchSize: number;
  generateId?: () => string;
  sourceEventIdPrefix?: string;
  source?: MembershipSource;
  nodeEnv?: string;
  requestId?: string | null;
};

export type ReconcileExpiredMembershipsResult = {
  processed: number;
  results: MembershipTransitionOutcome[];
};

function resolveReconcileSource(input: ReconcileExpiredMembershipsInput): MembershipSource {
  if (input.source) {
    return input.source;
  }
  const nodeEnv = input.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  return nodeEnv === 'production' ? 'stripe' : 'test_fixture';
}

export async function reconcileExpiredMemberships(
  db: Db,
  input: ReconcileExpiredMembershipsInput,
): Promise<ReconcileExpiredMembershipsResult> {
  const source = resolveReconcileSource(input);
  const prefix = input.sourceEventIdPrefix ?? 'internal_reconcile:';
  const results: MembershipTransitionOutcome[] = [];

  const candidates = await db.transaction(async (tx) =>
    findExpiredMembershipCandidates(tx as unknown as Db, {
      now: input.now,
      batchSize: input.batchSize,
    }),
  );

  for (const entitlement of candidates) {
    const sourceEventId = `${prefix}${entitlement.accountId}:${entitlement.accessUntil ?? 'null'}`;
    const outcome = await expireMembership(
      db,
      {
        source,
        sourceEventId,
        eventType: 'expire',
        accountId: entitlement.accountId,
        effectiveAt: input.now,
      },
      {
        ...(input.nodeEnv !== undefined ? { nodeEnv: input.nodeEnv } : {}),
        ...(input.generateId ? { generateId: input.generateId } : {}),
        processedAt: input.now,
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      },
    );
    results.push(outcome);
  }

  return {
    processed: results.length,
    results,
  };
}
