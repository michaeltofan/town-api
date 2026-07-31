import type { Database } from '../db/client.js';
import {
  listAuthoredSignalsForAccountActivity,
  listConfirmationsForActorActivity,
  listContributionsForActorActivity,
  listParticipatedSignalsForActorActivity,
} from '../db/repositories/member-activity.js';
import { findActiveCivicActorByAccountId } from '../db/repositories/confirmations.js';
import { toIsoTimestamp } from '../lib/timestamps.js';
import type { MemberActivityItem } from './member-activity-schemas.js';

type Db = Database['db'];

const PER_SOURCE_LIMIT = 50;
const RESPONSE_LIMIT = 100;

function signalView(signal: {
  id: string;
  slug: string;
  headline: string;
  community: { slug: string; displayName: string };
}) {
  return {
    id: signal.id,
    slug: signal.slug,
    headline: signal.headline,
    community: {
      slug: signal.community.slug,
      displayName: signal.community.displayName,
    },
  };
}

/**
 * Build the authenticated member's Activity feed from durable backend rows only:
 * confirmations, published discussion contributions, authored signals, and
 * current evolution fields for signals they participate in.
 */
export async function getMemberActivityView(
  db: Db,
  input: { accountId: string },
): Promise<{ items: MemberActivityItem[] }> {
  const actor = await findActiveCivicActorByAccountId(db, input.accountId);
  if (!actor) {
    return { items: [] };
  }

  const [confirmations, contributions, authored, participated] = await Promise.all([
    listConfirmationsForActorActivity(db, actor.id, PER_SOURCE_LIMIT),
    listContributionsForActorActivity(db, actor.id, PER_SOURCE_LIMIT),
    listAuthoredSignalsForAccountActivity(db, input.accountId, PER_SOURCE_LIMIT),
    listParticipatedSignalsForActorActivity(db, {
      actorId: actor.id,
      accountId: input.accountId,
      limit: PER_SOURCE_LIMIT,
    }),
  ]);

  const items: MemberActivityItem[] = [];

  for (const row of confirmations) {
    items.push({
      kind: 'confirmation',
      occurredAt: toIsoTimestamp(row.confirmedAt),
      signal: signalView(row.signal),
    });
  }

  for (const row of contributions) {
    items.push({
      kind: 'contribution',
      occurredAt: toIsoTimestamp(row.createdAt),
      signal: signalView(row.signal),
      contribution: {
        id: row.id,
        text: row.text,
        intent: row.intent,
      },
    });
  }

  for (const row of authored) {
    items.push({
      kind: 'signal_published',
      occurredAt: toIsoTimestamp(row.publishedAt),
      signal: signalView(row.signal),
    });
  }

  for (const signal of participated) {
    items.push({
      kind: 'signal_evolution',
      occurredAt: toIsoTimestamp(signal.updatedAt),
      signal: signalView(signal),
      evolution: {
        statusLabel: signal.statusLabel,
        statusNote: signal.statusNote,
        latestUpdate: signal.latestUpdate,
      },
    });
  }

  items.sort((a, b) => {
    if (a.occurredAt === b.occurredAt) {
      return a.kind.localeCompare(b.kind);
    }
    return a.occurredAt < b.occurredAt ? 1 : -1;
  });

  return { items: items.slice(0, RESPONSE_LIMIT) };
}
