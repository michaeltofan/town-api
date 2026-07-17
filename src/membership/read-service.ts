import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { actors } from '../db/schema.js';
import { findAccountById } from '../identity/repositories/accounts.js';
import { evaluateCivicAccess, resolveEffectiveMembershipStatus } from './civic-access.js';
import type { LocalParticipationEligibilityResolver } from './local-eligibility.js';
import { findEntitlementByAccountId } from './repositories/entitlements.js';
import type { AccountMembershipView } from './types.js';

type Db = Database['db'];

export async function getAccountMembershipView(
  db: Db,
  input: {
    accountId: string;
    session: null | { accountId: string };
    communityId?: string;
    localEligibilityResolver: LocalParticipationEligibilityResolver;
    now: string;
  },
): Promise<AccountMembershipView> {
  const [account, entitlement] = await Promise.all([
    findAccountById(db, input.accountId),
    findEntitlementByAccountId(db, input.accountId),
  ]);

  const actorRows = await db
    .select()
    .from(actors)
    .where(eq(actors.accountId, input.accountId))
    .limit(1);
  const actor = actorRows[0] ?? null;

  const localEligibility =
    actor && input.communityId
      ? await Promise.resolve(
          input.localEligibilityResolver({
            accountId: input.accountId,
            actorId: actor.id,
            communityId: input.communityId,
          }),
        )
      : 'unavailable';

  const access = evaluateCivicAccess({
    session: input.session,
    account: account ? { id: account.id, status: account.status } : null,
    entitlement,
    actor,
    ...(input.communityId !== undefined ? { communityId: input.communityId } : {}),
    localEligibility,
    now: input.now,
  });

  const effectiveStatus = resolveEffectiveMembershipStatus(entitlement, input.now);

  return {
    membership: {
      status: effectiveStatus,
      accessUntil: entitlement?.accessUntil ?? null,
      cancelAtPeriodEnd: entitlement?.cancelAtPeriodEnd ?? false,
    },
    access: {
      level: access.level,
      canParticipate: access.canParticipate,
      localEligibility: access.localEligibility,
    },
  };
}
