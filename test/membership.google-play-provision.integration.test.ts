import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createDatabase, type Database } from '../src/db/client.js';
import {
  googlePlayPurchaseLinks,
  membershipEntitlements,
  membershipSourceEvents,
} from '../src/db/schema.js';
import { createAccountShell } from '../src/identity/repositories/accounts.js';
import {
  evaluateCivicAccess,
  resolveEffectiveMembershipStatus,
} from '../src/membership/civic-access.js';
import { provisionGooglePlayPaidPendingBinding } from '../src/membership/google-play/provision-paid-pending-binding.js';
import { activateMembership } from '../src/membership/transitions/activate.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

const NOW = '2026-07-25T12:00:00.000Z';
const ACCESS_UNTIL = '2027-07-25T12:00:00.000Z';
const PACKAGE_NAME = 'com.town.town_safe_space_mobile';
const SUBSCRIPTION_ID = 'town_annual_membership';

describe('Google Play paid_pending_binding provision foundation', () => {
  let pool: Pool;
  let database: Database;
  const accountA = '11000000-0000-4000-8000-000000000501';
  const accountB = '11000000-0000-4000-8000-000000000502';
  const accountC = '11000000-0000-4000-8000-000000000503';
  const accountStripe = '11000000-0000-4000-8000-000000000504';
  const accountFixture = '11000000-0000-4000-8000-000000000505';
  const accountFail = '11000000-0000-4000-8000-000000000506';

  beforeAll(async () => {
    const url = requireDatabaseUrl();
    pool = new Pool({ connectionString: url, max: 1 });
    await resetMigrateSeedFoundationAndActor(pool);
    database = createDatabase({
      connectionString: url,
      poolMax: 3,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    for (const id of [
      accountA,
      accountB,
      accountC,
      accountStripe,
      accountFixture,
      accountFail,
    ]) {
      await createAccountShell(database.db, { id, createdAt: NOW, updatedAt: NOW });
    }
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it('accepts google_play as a membership source via paid_pending_binding provision', async () => {
    const outcome = await provisionGooglePlayPaidPendingBinding(
      database.db,
      {
        sourceEventId: 'gp_evt_source_accepted',
        accountId: accountA,
        effectiveAt: NOW,
        accessUntil: ACCESS_UNTIL,
        purchaseToken: 'gp_token_source_accepted',
        packageName: PACKAGE_NAME,
        subscriptionId: SUBSCRIPTION_ID,
      },
      { nodeEnv: 'test', processedAt: NOW },
    );
    expect(outcome.result).toBe('applied');
    expect(outcome.entitlement?.source).toBe('google_play');
    expect(outcome.entitlement?.status).toBe('paid_pending_binding');
  });

  it('preserves existing stripe and test_fixture activate behaviour', async () => {
    const stripe = await activateMembership(
      database.db,
      {
        source: 'stripe',
        sourceEventId: 'stripe_evt_still_works',
        eventType: 'activate',
        accountId: accountStripe,
        effectiveAt: NOW,
        accessUntil: ACCESS_UNTIL,
        sourceCustomerId: 'cus_s1',
        sourceSubscriptionId: 'sub_s1',
      },
      { nodeEnv: 'test', processedAt: NOW },
    );
    expect(stripe.result).toBe('applied');
    expect(stripe.entitlement?.status).toBe('active');
    expect(stripe.entitlement?.source).toBe('stripe');

    const fixture = await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'fixture_evt_still_works',
        eventType: 'activate',
        accountId: accountFixture,
        effectiveAt: NOW,
        accessUntil: ACCESS_UNTIL,
      },
      { nodeEnv: 'test', processedAt: NOW },
    );
    expect(fixture.result).toBe('applied');
    expect(fixture.entitlement?.status).toBe('active');
    expect(fixture.entitlement?.source).toBe('test_fixture');
  });

  it('provisions paid_pending_binding and never active', async () => {
    const outcome = await provisionGooglePlayPaidPendingBinding(
      database.db,
      {
        sourceEventId: 'gp_evt_never_active',
        accountId: accountB,
        effectiveAt: NOW,
        accessUntil: ACCESS_UNTIL,
        purchaseToken: 'gp_token_never_active',
        packageName: PACKAGE_NAME,
        subscriptionId: SUBSCRIPTION_ID,
      },
      { nodeEnv: 'test', processedAt: NOW },
    );
    expect(outcome.result).toBe('applied');
    expect(outcome.entitlement?.status).toBe('paid_pending_binding');
    expect(outcome.entitlement?.status).not.toBe('active');
    expect(outcome.entitlement?.activatedAt).toBeNull();
    expect(outcome.entitlement?.cancelAtPeriodEnd).toBe(false);
    expect(outcome.purchaseLink?.purchaseToken).toBe('gp_token_never_active');
    expect(outcome.purchaseLink?.accountId).toBe(accountB);
    expect(outcome.purchaseLink?.entitlementId).toBe(outcome.entitlement?.id);
  });

  it('paid_pending_binding fails closed for membership-active and civic participation checks', async () => {
    const rows = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountB))
      .limit(1);
    const entitlement = rows[0];
    expect(entitlement).toBeDefined();
    expect(entitlement?.status).toBe('paid_pending_binding');

    expect(resolveEffectiveMembershipStatus(entitlement ?? null, NOW)).toBe(
      'paid_pending_binding',
    );
    expect(['active', 'cancelling']).not.toContain(
      resolveEffectiveMembershipStatus(entitlement ?? null, NOW),
    );

    const access = evaluateCivicAccess({
      session: { accountId: accountB },
      account: {
        id: accountB,
        status: 'active',
      },
      entitlement: entitlement ?? null,
      actor: {
        id: '20000000-0000-4000-8000-000000000501',
        accountId: accountB,
        communityId: '00000000-0000-4000-8000-000000000001',
        kind: 'civic',
        status: 'active',
      },
      communityId: '00000000-0000-4000-8000-000000000001',
      localEligibility: 'eligible',
      now: NOW,
    });
    expect(access.canParticipate).toBe(false);
    expect(access.level).toBe('read_only');
    expect(access.denialReason).toBe('inactive_membership');
  });

  it('exact replay of the same operation/event and payload is idempotent', async () => {
    const payload = {
      sourceEventId: 'gp_evt_idempotent_replay',
      accountId: accountC,
      effectiveAt: NOW,
      accessUntil: ACCESS_UNTIL,
      purchaseToken: 'gp_token_idempotent_replay',
      packageName: PACKAGE_NAME,
      subscriptionId: SUBSCRIPTION_ID,
    };
    const first = await provisionGooglePlayPaidPendingBinding(database.db, payload, {
      nodeEnv: 'test',
      processedAt: NOW,
    });
    expect(first.result).toBe('applied');
    const firstVersion = first.entitlement?.version;
    const firstUpdatedAt = first.entitlement?.updatedAt;

    const replay = await provisionGooglePlayPaidPendingBinding(database.db, payload, {
      nodeEnv: 'test',
      processedAt: '2026-07-26T00:00:00.000Z',
    });
    expect(replay.result).toBe('replayed');
    expect(Number(replay.entitlement?.version)).toBe(Number(firstVersion));
    expect(replay.entitlement?.updatedAt).toBe(firstUpdatedAt);
    expect(replay.entitlement?.status).toBe('paid_pending_binding');

    const ledger = await database.db
      .select()
      .from(membershipSourceEvents)
      .where(eq(membershipSourceEvents.sourceEventId, 'gp_evt_idempotent_replay'));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.result).toBe('applied');
    expect(ledger[0]?.source).toBe('google_play');

    const links = await database.db
      .select()
      .from(googlePlayPurchaseLinks)
      .where(eq(googlePlayPurchaseLinks.purchaseToken, 'gp_token_idempotent_replay'));
    expect(links).toHaveLength(1);
  });

  it('rejects reuse of the same event id with a different payload via payload_hash_mismatch', async () => {
    const before = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountC))
      .limit(1);
    const beforeVersion = Number(before[0]?.version);
    const beforeUpdatedAt = before[0]?.updatedAt;

    const conflicting = await provisionGooglePlayPaidPendingBinding(
      database.db,
      {
        sourceEventId: 'gp_evt_idempotent_replay',
        accountId: accountC,
        effectiveAt: NOW,
        accessUntil: '2028-01-01T00:00:00.000Z',
        purchaseToken: 'gp_token_idempotent_replay',
        packageName: PACKAGE_NAME,
        subscriptionId: SUBSCRIPTION_ID,
      },
      { nodeEnv: 'test', processedAt: '2026-07-27T00:00:00.000Z' },
    );
    expect(conflicting.result).toBe('rejected');
    expect(conflicting.reason).toBe('payload_hash_mismatch');

    const after = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountC))
      .limit(1);
    expect(Number(after[0]?.version)).toBe(beforeVersion);
    expect(after[0]?.updatedAt).toBe(beforeUpdatedAt);
  });

  it('rejects correlating one purchase token with a second account', async () => {
    const token = 'gp_token_cross_account';
    const firstAccount = '11000000-0000-4000-8000-000000000507';
    const secondAccount = '11000000-0000-4000-8000-000000000508';
    await createAccountShell(database.db, {
      id: firstAccount,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await createAccountShell(database.db, {
      id: secondAccount,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const first = await provisionGooglePlayPaidPendingBinding(
      database.db,
      {
        sourceEventId: 'gp_evt_cross_account_1',
        accountId: firstAccount,
        effectiveAt: NOW,
        accessUntil: ACCESS_UNTIL,
        purchaseToken: token,
        packageName: PACKAGE_NAME,
        subscriptionId: SUBSCRIPTION_ID,
      },
      { nodeEnv: 'test', processedAt: NOW },
    );
    expect(first.result).toBe('applied');

    const second = await provisionGooglePlayPaidPendingBinding(
      database.db,
      {
        sourceEventId: 'gp_evt_cross_account_2',
        accountId: secondAccount,
        effectiveAt: NOW,
        accessUntil: ACCESS_UNTIL,
        purchaseToken: token,
        packageName: PACKAGE_NAME,
        subscriptionId: SUBSCRIPTION_ID,
      },
      { nodeEnv: 'test', processedAt: NOW },
    );
    expect(second.result).toBe('rejected');
    expect(second.reason).toBe('purchase_token_already_correlated');

    const secondEntitlements = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, secondAccount));
    expect(secondEntitlements).toHaveLength(0);

    const links = await database.db
      .select()
      .from(googlePlayPurchaseLinks)
      .where(eq(googlePlayPurchaseLinks.purchaseToken, token));
    expect(links).toHaveLength(1);
    expect(links[0]?.accountId).toBe(firstAccount);
  });

  it('rolls back entitlement writes when purchase-link persistence fails mid-provision', async () => {
    let calls = 0;
    await expect(
      provisionGooglePlayPaidPendingBinding(
        database.db,
        {
          sourceEventId: 'gp_evt_partial_failure',
          accountId: accountFail,
          effectiveAt: NOW,
          accessUntil: ACCESS_UNTIL,
          purchaseToken: 'gp_token_partial_failure',
          packageName: PACKAGE_NAME,
          subscriptionId: SUBSCRIPTION_ID,
        },
        {
          nodeEnv: 'test',
          processedAt: NOW,
          generateId: () => {
            calls += 1;
            // 1 = entitlement id; 2 = purchase link id — fail before link insert commits.
            if (calls === 2) {
              throw new Error('injected_failure_before_purchase_link');
            }
            return randomUUID();
          },
        },
      ),
    ).rejects.toThrow(/injected_failure_before_purchase_link/);

    const entitlements = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountFail));
    expect(entitlements).toHaveLength(0);

    const links = await database.db
      .select()
      .from(googlePlayPurchaseLinks)
      .where(eq(googlePlayPurchaseLinks.purchaseToken, 'gp_token_partial_failure'));
    expect(links).toHaveLength(0);

    const events = await database.db
      .select()
      .from(membershipSourceEvents)
      .where(eq(membershipSourceEvents.sourceEventId, 'gp_evt_partial_failure'));
    expect(events).toHaveLength(0);
  });
});
