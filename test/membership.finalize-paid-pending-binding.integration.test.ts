import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDatabase, type Database } from '../src/db/client.js';
import { FOUNDATION_COMMUNITY_IDS } from '../src/db/seeds/foundation-content.js';
import {
  accounts,
  actors,
  identitySecurityEvents,
  membershipEntitlements,
  membershipSourceEvents,
} from '../src/db/schema.js';
import { createAccountShell } from '../src/identity/repositories/accounts.js';
import { createCivicActor, linkActorToAccount } from '../src/identity/repositories/actor-link.js';
import {
  evaluateCivicAccess,
  resolveEffectiveMembershipStatus,
} from '../src/membership/civic-access.js';
import {
  buildFinalizePaidPendingBindingSourceEventId,
  maybeFinalizePaidPendingBindingAfterCommunityBind,
} from '../src/membership/finalize-after-community-bind.js';
import { provisionGooglePlayPaidPendingBinding } from '../src/membership/google-play/provision-paid-pending-binding.js';
import { activateMembership } from '../src/membership/transitions/activate.js';
import { finalizePaidPendingBindingMembership } from '../src/membership/transitions/finalize-paid-pending-binding.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

const NOW = '2026-07-25T16:00:00.000Z';
const ACCESS_UNTIL = '2027-07-25T16:00:00.000Z';
const PACKAGE_NAME = 'com.town.town_safe_space_mobile';
const SUBSCRIPTION_ID = 'town_annual_membership';
const COMMUNITY_ID = FOUNDATION_COMMUNITY_IDS.milanoIt;

function iso(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return new Date(value).toISOString();
}

async function makeActiveAccountWithActor(
  database: Database,
  accountId: string,
  actorId: string,
  options: { bindCommunity?: boolean } = {},
): Promise<void> {
  await createAccountShell(database.db, { id: accountId, createdAt: NOW, updatedAt: NOW });
  const handle = Buffer.alloc(32, 0);
  Buffer.from(accountId.replace(/-/g, ''), 'hex').copy(handle, 0, 0, 16);
  await database.db
    .update(accounts)
    .set({
      webauthnUserHandle: handle,
      status: 'active',
      accountReadyAt: NOW,
      updatedAt: NOW,
    })
    .where(eq(accounts.id, accountId));

  await createCivicActor(database.db, {
    id: actorId,
    displayLabel: `actor-${actorId.slice(-4)}`,
    communityId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await linkActorToAccount(database.db, {
    actorId,
    accountId,
    at: NOW,
  });

  if (options.bindCommunity) {
    await database.db
      .update(actors)
      .set({
        communityId: COMMUNITY_ID,
        localEligibilityVerifiedAt: NOW,
        updatedAt: NOW,
      })
      .where(eq(actors.id, actorId));
  }
}

async function provisionPending(
  database: Database,
  input: { accountId: string; sourceEventId: string; purchaseToken: string },
) {
  return provisionGooglePlayPaidPendingBinding(
    database.db,
    {
      sourceEventId: input.sourceEventId,
      accountId: input.accountId,
      effectiveAt: NOW,
      accessUntil: ACCESS_UNTIL,
      purchaseToken: input.purchaseToken,
      packageName: PACKAGE_NAME,
      subscriptionId: SUBSCRIPTION_ID,
    },
    { nodeEnv: 'test', processedAt: NOW },
  );
}

describe('membership finalize_paid_pending_binding (S5)', () => {
  let pool: Pool;
  let database: Database;

  const accountSuccess = '11000000-0000-4000-8000-000000000601';
  const actorSuccess = '20000000-0000-4000-8000-000000000601';
  const accountUnbound = '11000000-0000-4000-8000-000000000602';
  const actorUnbound = '20000000-0000-4000-8000-000000000602';
  const accountInvalid = '11000000-0000-4000-8000-000000000603';
  const actorInvalid = '20000000-0000-4000-8000-000000000603';
  const accountReplay = '11000000-0000-4000-8000-000000000604';
  const actorReplay = '20000000-0000-4000-8000-000000000604';
  const accountConcurrent = '11000000-0000-4000-8000-000000000605';
  const actorConcurrent = '20000000-0000-4000-8000-000000000605';
  const accountCivic = '11000000-0000-4000-8000-000000000606';
  const actorCivic = '20000000-0000-4000-8000-000000000606';
  const accountActivateReject = '11000000-0000-4000-8000-000000000607';
  const actorActivateReject = '20000000-0000-4000-8000-000000000607';
  const accountSkip = '11000000-0000-4000-8000-000000000608';
  const actorSkip = '20000000-0000-4000-8000-000000000608';

  beforeAll(async () => {
    const url = requireDatabaseUrl();
    pool = new Pool({ connectionString: url, max: 1 });
    await resetMigrateSeedFoundationAndActor(pool);
    database = createDatabase({
      connectionString: url,
      poolMax: 8,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });

    await makeActiveAccountWithActor(database, accountSuccess, actorSuccess, {
      bindCommunity: true,
    });
    await makeActiveAccountWithActor(database, accountUnbound, actorUnbound, {
      bindCommunity: false,
    });
    await makeActiveAccountWithActor(database, accountInvalid, actorInvalid, {
      bindCommunity: true,
    });
    await makeActiveAccountWithActor(database, accountReplay, actorReplay, {
      bindCommunity: true,
    });
    await makeActiveAccountWithActor(database, accountConcurrent, actorConcurrent, {
      bindCommunity: true,
    });
    await makeActiveAccountWithActor(database, accountCivic, actorCivic, {
      bindCommunity: true,
    });
    await makeActiveAccountWithActor(database, accountActivateReject, actorActivateReject, {
      bindCommunity: true,
    });
    await makeActiveAccountWithActor(database, accountSkip, actorSkip, {
      bindCommunity: true,
    });
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it('finalises paid_pending_binding to active when community-binding preconditions are met', async () => {
    const provisioned = await provisionPending(database, {
      accountId: accountSuccess,
      sourceEventId: 'gp_evt_finalize_success',
      purchaseToken: 'gp_token_finalize_success',
    });
    expect(provisioned.result).toBe('applied');
    expect(provisioned.entitlement?.status).toBe('paid_pending_binding');

    const outcome = await maybeFinalizePaidPendingBindingAfterCommunityBind(
      database.db,
      {
        accountId: accountSuccess,
        communityId: COMMUNITY_ID,
        effectiveAt: NOW,
      },
      { nodeEnv: 'test', processedAt: NOW },
    );

    expect(outcome.result).toBe('applied');
    expect(outcome.entitlement?.status).toBe('active');
    expect(iso(outcome.entitlement?.activatedAt)).toBe(NOW);
    expect(iso(outcome.entitlement?.accessUntil)).toBe(ACCESS_UNTIL);
    expect(outcome.entitlement?.cancelAtPeriodEnd).toBe(false);
    expect(Number(outcome.entitlement?.version)).toBe(2);

    const events = await database.db
      .select()
      .from(membershipSourceEvents)
      .where(
        and(
          eq(membershipSourceEvents.source, 'google_play'),
          eq(
            membershipSourceEvents.sourceEventId,
            buildFinalizePaidPendingBindingSourceEventId({
              accountId: accountSuccess,
              communityId: COMMUNITY_ID,
            }),
          ),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('finalize_paid_pending_binding');
    expect(events[0]?.result).toBe('applied');

    const audits = await database.db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, accountSuccess),
          eq(identitySecurityEvents.eventType, 'membership_activated'),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('skips finalisation when community-binding / local-eligibility preconditions are unmet', async () => {
    await provisionPending(database, {
      accountId: accountUnbound,
      sourceEventId: 'gp_evt_finalize_unbound',
      purchaseToken: 'gp_token_finalize_unbound',
    });

    const outcome = await maybeFinalizePaidPendingBindingAfterCommunityBind(
      database.db,
      {
        accountId: accountUnbound,
        communityId: COMMUNITY_ID,
        effectiveAt: NOW,
      },
      { nodeEnv: 'test', processedAt: NOW },
    );

    expect(outcome.result).toBe('skipped');
    if (outcome.result === 'skipped') {
      expect(outcome.reason).toBe('community_binding_preconditions_unmet');
    }

    const entitlement = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountUnbound))
      .limit(1);
    expect(entitlement[0]?.status).toBe('paid_pending_binding');

    const ledger = await database.db
      .select()
      .from(membershipSourceEvents)
      .where(
        and(
          eq(membershipSourceEvents.source, 'google_play'),
          eq(
            membershipSourceEvents.sourceEventId,
            buildFinalizePaidPendingBindingSourceEventId({
              accountId: accountUnbound,
              communityId: COMMUNITY_ID,
            }),
          ),
        ),
      );
    expect(ledger).toHaveLength(0);
  });

  it('rejects finalisation from an invalid entitlement status', async () => {
    const activated = await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_finalize_invalid_activate_first',
        eventType: 'activate',
        accountId: accountInvalid,
        effectiveAt: NOW,
        accessUntil: ACCESS_UNTIL,
      },
      { nodeEnv: 'test', processedAt: NOW },
    );
    expect(activated.result).toBe('applied');
    expect(activated.entitlement?.status).toBe('active');

    const skipped = await maybeFinalizePaidPendingBindingAfterCommunityBind(
      database.db,
      {
        accountId: accountInvalid,
        communityId: COMMUNITY_ID,
        effectiveAt: NOW,
      },
      { nodeEnv: 'test', processedAt: NOW },
    );
    expect(skipped.result).toBe('skipped');
    if (skipped.result === 'skipped') {
      expect(skipped.reason).toBe('not_paid_pending_binding');
    }

    const direct = await finalizePaidPendingBindingMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_finalize_invalid_direct',
        eventType: 'finalize_paid_pending_binding',
        accountId: accountInvalid,
        effectiveAt: NOW,
        accessUntil: ACCESS_UNTIL,
      },
      { nodeEnv: 'test', processedAt: NOW },
    );
    expect(direct.result).toBe('rejected');
    expect(direct.reason).toBe('invalid_status_for_finalize_paid_pending_binding');
  });

  it('replays identical finalisation events idempotently', async () => {
    await provisionPending(database, {
      accountId: accountReplay,
      sourceEventId: 'gp_evt_finalize_replay_provision',
      purchaseToken: 'gp_token_finalize_replay',
    });

    const pending = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountReplay))
      .limit(1);
    const accessUntil = pending[0]?.accessUntil;
    expect(accessUntil).toBeTruthy();

    const payload = {
      source: 'google_play' as const,
      sourceEventId: buildFinalizePaidPendingBindingSourceEventId({
        accountId: accountReplay,
        communityId: COMMUNITY_ID,
      }),
      eventType: 'finalize_paid_pending_binding' as const,
      accountId: accountReplay,
      effectiveAt: NOW,
      accessUntil: accessUntil ?? ACCESS_UNTIL,
    };

    const first = await finalizePaidPendingBindingMembership(database.db, payload, {
      nodeEnv: 'test',
      processedAt: NOW,
    });
    expect(first.result).toBe('applied');
    expect(Number(first.entitlement?.version)).toBe(2);

    const second = await finalizePaidPendingBindingMembership(database.db, payload, {
      nodeEnv: 'test',
      processedAt: NOW,
    });
    expect(second.result).toBe('replayed');
    expect(second.entitlement?.status).toBe('active');
    expect(Number(second.entitlement?.version)).toBe(2);

    // Wrapper skips once already active; transition-level replay remains the
    // source-event idempotency path.
    const skipped = await maybeFinalizePaidPendingBindingAfterCommunityBind(
      database.db,
      {
        accountId: accountReplay,
        communityId: COMMUNITY_ID,
        effectiveAt: NOW,
      },
      { nodeEnv: 'test', processedAt: NOW },
    );
    expect(skipped.result).toBe('skipped');

    const ledger = await database.db
      .select()
      .from(membershipSourceEvents)
      .where(
        and(
          eq(membershipSourceEvents.source, 'google_play'),
          eq(membershipSourceEvents.sourceEventId, payload.sourceEventId),
        ),
      );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.result).toBe('applied');
  });

  it('concurrent identical finalisations yield one applied and the rest replayed', async () => {
    await provisionPending(database, {
      accountId: accountConcurrent,
      sourceEventId: 'gp_evt_finalize_concurrent_provision',
      purchaseToken: 'gp_token_finalize_concurrent',
    });

    const pending = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountConcurrent))
      .limit(1);
    const accessUntil = pending[0]?.accessUntil;
    expect(accessUntil).toBeTruthy();

    const payload = {
      source: 'google_play' as const,
      sourceEventId: buildFinalizePaidPendingBindingSourceEventId({
        accountId: accountConcurrent,
        communityId: COMMUNITY_ID,
      }),
      eventType: 'finalize_paid_pending_binding' as const,
      accountId: accountConcurrent,
      effectiveAt: NOW,
      accessUntil: accessUntil ?? ACCESS_UNTIL,
    };

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        finalizePaidPendingBindingMembership(database.db, payload, {
          nodeEnv: 'test',
          processedAt: NOW,
        }),
      ),
    );

    expect(outcomes.filter((o) => o.result === 'applied')).toHaveLength(1);
    expect(outcomes.filter((o) => o.result === 'replayed')).toHaveLength(4);

    const entitlement = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountConcurrent))
      .limit(1);
    expect(entitlement[0]?.status).toBe('active');
    expect(Number(entitlement[0]?.version)).toBe(2);

    const ledger = await database.db
      .select()
      .from(membershipSourceEvents)
      .where(
        and(
          eq(membershipSourceEvents.source, 'google_play'),
          eq(membershipSourceEvents.sourceEventId, payload.sourceEventId),
        ),
      );
    expect(ledger).toHaveLength(1);
  });

  it('civic access stays read_only before finalisation and can become participant after', async () => {
    await provisionPending(database, {
      accountId: accountCivic,
      sourceEventId: 'gp_evt_finalize_civic_provision',
      purchaseToken: 'gp_token_finalize_civic',
    });

    const beforeRows = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountCivic))
      .limit(1);
    const before = beforeRows[0];
    expect(before).toBeDefined();
    expect(resolveEffectiveMembershipStatus(before ?? null, NOW)).toBe('paid_pending_binding');

    const beforeAccess = evaluateCivicAccess({
      session: { accountId: accountCivic },
      account: { id: accountCivic, status: 'active' },
      entitlement: before ?? null,
      actor: {
        id: actorCivic,
        accountId: accountCivic,
        communityId: COMMUNITY_ID,
        kind: 'civic',
        status: 'active',
      },
      communityId: COMMUNITY_ID,
      localEligibility: 'eligible',
      now: NOW,
    });
    expect(beforeAccess.canParticipate).toBe(false);
    expect(beforeAccess.level).toBe('read_only');
    expect(beforeAccess.denialReason).toBe('inactive_membership');

    const finalized = await maybeFinalizePaidPendingBindingAfterCommunityBind(
      database.db,
      {
        accountId: accountCivic,
        communityId: COMMUNITY_ID,
        effectiveAt: NOW,
      },
      { nodeEnv: 'test', processedAt: NOW },
    );
    expect(finalized.result).toBe('applied');

    const afterAccess = evaluateCivicAccess({
      session: { accountId: accountCivic },
      account: { id: accountCivic, status: 'active' },
      entitlement: finalized.entitlement ?? null,
      actor: {
        id: actorCivic,
        accountId: accountCivic,
        communityId: COMMUNITY_ID,
        kind: 'civic',
        status: 'active',
      },
      communityId: COMMUNITY_ID,
      localEligibility: 'eligible',
      now: NOW,
    });
    expect(afterAccess.canParticipate).toBe(true);
    expect(afterAccess.level).toBe('participant');
  });

  it('activate still rejects paid_pending_binding (S1–S4 invariant)', async () => {
    await provisionPending(database, {
      accountId: accountActivateReject,
      sourceEventId: 'gp_evt_activate_still_rejects',
      purchaseToken: 'gp_token_activate_still_rejects',
    });

    const outcome = await activateMembership(
      database.db,
      {
        source: 'google_play',
        sourceEventId: 'evt_activate_from_paid_pending',
        eventType: 'activate',
        accountId: accountActivateReject,
        effectiveAt: NOW,
        accessUntil: ACCESS_UNTIL,
      },
      { nodeEnv: 'test', processedAt: NOW },
    );
    expect(outcome.result).toBe('rejected');
    expect(outcome.reason).toBe('invalid_status_for_activate');

    const entitlement = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountActivateReject))
      .limit(1);
    expect(entitlement[0]?.status).toBe('paid_pending_binding');
    expect(entitlement[0]?.activatedAt).toBeNull();
  });

  it('skips without poisoning idempotency when entitlement is absent', async () => {
    const outcome = await maybeFinalizePaidPendingBindingAfterCommunityBind(
      database.db,
      {
        accountId: accountSkip,
        communityId: COMMUNITY_ID,
        effectiveAt: NOW,
      },
      { nodeEnv: 'test', processedAt: NOW },
    );
    expect(outcome.result).toBe('skipped');
    if (outcome.result === 'skipped') {
      expect(outcome.reason).toBe('entitlement_missing');
    }

    await provisionPending(database, {
      accountId: accountSkip,
      sourceEventId: 'gp_evt_finalize_after_skip_provision',
      purchaseToken: 'gp_token_finalize_after_skip',
    });

    const finalized = await maybeFinalizePaidPendingBindingAfterCommunityBind(
      database.db,
      {
        accountId: accountSkip,
        communityId: COMMUNITY_ID,
        effectiveAt: NOW,
      },
      { nodeEnv: 'test', processedAt: NOW },
    );
    expect(finalized.result).toBe('applied');
    expect(finalized.entitlement?.status).toBe('active');
  });
});
