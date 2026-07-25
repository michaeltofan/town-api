import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDatabase, type Database } from '../src/db/client.js';
import {
  googlePlayPurchaseLinks,
  membershipEntitlements,
  membershipSourceEvents,
} from '../src/db/schema.js';
import { createAccountShell } from '../src/identity/repositories/accounts.js';
import {
  createFakeGooglePlayAndroidPublisherAdapter,
  createFakeGooglePlayAndroidPublisherState,
  setFakeGooglePlaySubscription,
  type FakeGooglePlayAndroidPublisherState,
} from '../src/membership/google-play/android-publisher-adapter.js';
import { verifyAndProvisionGooglePlayPurchase } from '../src/membership/google-play/verify-and-provision.js';
import {
  evaluateCivicAccess,
  resolveEffectiveMembershipStatus,
} from '../src/membership/civic-access.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

const NOW = '2026-07-25T12:00:00.000Z';
const ACCESS_UNTIL = '2027-07-25T12:00:00.000Z';
const PACKAGE_NAME = 'com.town.town_safe_space_mobile';
const SUBSCRIPTION_ID = 'town_annual_membership';

describe('Google Play verify-and-provision S2/S4', () => {
  let pool: Pool;
  let database: Database;
  const accountOk = '11000000-0000-4000-8000-000000000701';
  const accountDisabled = '11000000-0000-4000-8000-000000000702';
  const accountBadProduct = '11000000-0000-4000-8000-000000000703';
  const accountReplay = '11000000-0000-4000-8000-000000000704';
  const accountAckFail = '11000000-0000-4000-8000-000000000705';
  const accountAlreadyAck = '11000000-0000-4000-8000-000000000706';
  const accountCrossA = '11000000-0000-4000-8000-000000000707';
  const accountCrossB = '11000000-0000-4000-8000-000000000708';

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
      accountOk,
      accountDisabled,
      accountBadProduct,
      accountReplay,
      accountAckFail,
      accountAlreadyAck,
      accountCrossA,
      accountCrossB,
    ]) {
      await createAccountShell(database.db, { id, createdAt: NOW, updatedAt: NOW });
    }
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  function config(enabled = true) {
    return {
      enabled,
      packageName: PACKAGE_NAME,
      subscriptionId: SUBSCRIPTION_ID,
    };
  }

  function seedActivePurchase(
    state: FakeGooglePlayAndroidPublisherState,
    token: string,
    productId = SUBSCRIPTION_ID,
  ): void {
    setFakeGooglePlaySubscription(state, {
      packageName: PACKAGE_NAME,
      purchaseToken: token,
      purchase: {
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
        lineItems: [{ productId, expiryTime: ACCESS_UNTIL }],
      },
    });
  }

  it('verifies then provisions paid_pending_binding and never active', async () => {
    const state = createFakeGooglePlayAndroidPublisherState();
    const token = 'gp_token_s2_ok';
    seedActivePurchase(state, token);

    const outcome = await verifyAndProvisionGooglePlayPurchase(
      database.db,
      {
        accountId: accountOk,
        purchaseToken: token,
        effectiveAt: NOW,
      },
      {
        nodeEnv: 'test',
        processedAt: NOW,
        config: config(true),
        adapter: createFakeGooglePlayAndroidPublisherAdapter(state),
      },
    );

    expect(outcome.verification).toBe('verified');
    expect(outcome.result).toBe('applied');
    if (outcome.verification !== 'verified') {
      throw new Error('expected verified outcome');
    }
    expect(outcome.acknowledgement).toBe('acknowledged');
    expect(outcome.entitlement?.status).toBe('paid_pending_binding');
    expect(outcome.entitlement?.status).not.toBe('active');
    expect(outcome.entitlement?.activatedAt).toBeNull();
    expect(outcome.purchaseLink?.purchaseToken).toBe(token);
    expect(state.acknowledgedTokens.has(token)).toBe(true);

    const access = evaluateCivicAccess({
      session: { accountId: accountOk },
      account: { id: accountOk, status: 'active' },
      entitlement: outcome.entitlement ?? null,
      actor: {
        id: '20000000-0000-4000-8000-000000000701',
        accountId: accountOk,
        communityId: '00000000-0000-4000-8000-000000000001',
        kind: 'civic',
        status: 'active',
      },
      communityId: '00000000-0000-4000-8000-000000000001',
      localEligibility: 'eligible',
      now: NOW,
    });
    expect(access.canParticipate).toBe(false);
    expect(resolveEffectiveMembershipStatus(outcome.entitlement ?? null, NOW)).toBe(
      'paid_pending_binding',
    );
  });

  it('fail-closes when disabled and never provisions', async () => {
    let called = false;
    const outcome = await verifyAndProvisionGooglePlayPurchase(
      database.db,
      {
        accountId: accountDisabled,
        purchaseToken: 'gp_token_s2_disabled',
        effectiveAt: NOW,
      },
      {
        nodeEnv: 'test',
        processedAt: NOW,
        config: config(false),
        adapter: {
          getSubscriptionV2: () => {
            called = true;
            return Promise.reject(new Error('should not be called'));
          },
          acknowledgeSubscription: () => {
            called = true;
            return Promise.reject(new Error('should not be called'));
          },
        },
      },
    );

    expect(outcome).toEqual({
      result: 'rejected',
      reason: 'google_play_billing_disabled',
      verification: 'failed',
    });
    expect(called).toBe(false);

    const entitlements = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountDisabled));
    expect(entitlements).toHaveLength(0);

    const links = await database.db
      .select()
      .from(googlePlayPurchaseLinks)
      .where(eq(googlePlayPurchaseLinks.purchaseToken, 'gp_token_s2_disabled'));
    expect(links).toHaveLength(0);
  });

  it('does not provision when Google returns a mismatched product id', async () => {
    const state = createFakeGooglePlayAndroidPublisherState();
    const token = 'gp_token_s2_bad_product';
    seedActivePurchase(state, token, 'wrong_product');

    const outcome = await verifyAndProvisionGooglePlayPurchase(
      database.db,
      {
        accountId: accountBadProduct,
        purchaseToken: token,
        effectiveAt: NOW,
      },
      {
        nodeEnv: 'test',
        processedAt: NOW,
        config: config(true),
        adapter: createFakeGooglePlayAndroidPublisherAdapter(state),
      },
    );

    expect(outcome).toEqual({
      result: 'rejected',
      reason: 'subscription_product_id_mismatch',
      verification: 'failed',
    });

    const entitlements = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountBadProduct));
    expect(entitlements).toHaveLength(0);
  });

  it('replays idempotently after a successful verify-and-provision', async () => {
    const state = createFakeGooglePlayAndroidPublisherState();
    const token = 'gp_token_s2_replay';
    seedActivePurchase(state, token);
    const adapter = createFakeGooglePlayAndroidPublisherAdapter(state);

    const first = await verifyAndProvisionGooglePlayPurchase(
      database.db,
      {
        accountId: accountReplay,
        purchaseToken: token,
        effectiveAt: NOW,
      },
      {
        nodeEnv: 'test',
        processedAt: NOW,
        config: config(true),
        adapter,
      },
    );
    expect(first.verification).toBe('verified');
    expect(first.result).toBe('applied');

    const replay = await verifyAndProvisionGooglePlayPurchase(
      database.db,
      {
        accountId: accountReplay,
        purchaseToken: token,
        effectiveAt: NOW,
      },
      {
        nodeEnv: 'test',
        processedAt: '2026-07-26T00:00:00.000Z',
        config: config(true),
        adapter,
      },
    );
    expect(replay.verification).toBe('verified');
    expect(replay.result).toBe('replayed');
    if (first.verification !== 'verified' || replay.verification !== 'verified') {
      throw new Error('expected verified outcomes');
    }
    expect(first.acknowledgement).toBe('acknowledged');
    expect(replay.acknowledgement).toBe('already_acknowledged');
    expect(Number(replay.entitlement?.version)).toBe(Number(first.entitlement?.version));

    const ledger = await database.db
      .select()
      .from(membershipSourceEvents)
      .where(eq(membershipSourceEvents.sourceEventId, `google_play:subscriptionsv2:${token}`));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.result).toBe('applied');
  });

  it('never acknowledges after verification failure', async () => {
    let acknowledgeCalled = false;
    const outcome = await verifyAndProvisionGooglePlayPurchase(
      database.db,
      {
        accountId: accountBadProduct,
        purchaseToken: 'gp_token_s4_verify_fail_ack',
        effectiveAt: NOW,
      },
      {
        nodeEnv: 'test',
        processedAt: NOW,
        config: config(true),
        adapter: {
          getSubscriptionV2: () => Promise.reject(new Error('verification transport failed')),
          acknowledgeSubscription: () => {
            acknowledgeCalled = true;
            return Promise.reject(new Error('should not acknowledge'));
          },
        },
      },
    );

    expect(outcome).toEqual({
      result: 'rejected',
      reason: 'google_play_verification_transport_failed',
      verification: 'failed',
    });
    expect(acknowledgeCalled).toBe(false);
  });

  it('never acknowledges after cross-account purchase-token rejection', async () => {
    const state = createFakeGooglePlayAndroidPublisherState();
    const token = 'gp_token_s4_cross_account';
    seedActivePurchase(state, token);
    const adapter = createFakeGooglePlayAndroidPublisherAdapter(state);

    const first = await verifyAndProvisionGooglePlayPurchase(
      database.db,
      {
        accountId: accountCrossA,
        purchaseToken: token,
        effectiveAt: NOW,
      },
      {
        nodeEnv: 'test',
        processedAt: NOW,
        config: config(true),
        adapter,
      },
    );
    expect(first.result).toBe('applied');
    if (first.verification !== 'verified') {
      throw new Error('expected verified first outcome');
    }
    expect(first.acknowledgement).toBe('acknowledged');
    expect(state.acknowledgedTokens.has(token)).toBe(true);

    let acknowledgeCalls = 0;
    const originalAcknowledge = adapter.acknowledgeSubscription.bind(adapter);
    adapter.acknowledgeSubscription = (input) => {
      acknowledgeCalls += 1;
      return originalAcknowledge(input);
    };

    const cross = await verifyAndProvisionGooglePlayPurchase(
      database.db,
      {
        accountId: accountCrossB,
        purchaseToken: token,
        effectiveAt: NOW,
      },
      {
        nodeEnv: 'test',
        processedAt: '2026-07-26T00:00:00.000Z',
        config: config(true),
        adapter,
      },
    );

    expect(cross.verification).toBe('verified');
    expect(cross.result).toBe('rejected');
    if (cross.verification !== 'verified') {
      throw new Error('expected verified cross-account rejection');
    }
    expect(cross.reason).toMatch(/purchase_token_already_correlated|payload_hash_mismatch/);
    expect(cross.acknowledgement).toBeUndefined();
    expect(acknowledgeCalls).toBe(0);
  });

  it('surfaces acknowledgement transport failure after durable provision', async () => {
    const state = createFakeGooglePlayAndroidPublisherState();
    const token = 'gp_token_s4_ack_transport_fail';
    seedActivePurchase(state, token);
    state.errorHooks.acknowledgeSubscription = () => new Error('acknowledge network down');

    const outcome = await verifyAndProvisionGooglePlayPurchase(
      database.db,
      {
        accountId: accountAckFail,
        purchaseToken: token,
        effectiveAt: NOW,
      },
      {
        nodeEnv: 'test',
        processedAt: NOW,
        config: config(true),
        adapter: createFakeGooglePlayAndroidPublisherAdapter(state),
      },
    );

    expect(outcome.verification).toBe('verified');
    expect(outcome.result).toBe('applied');
    if (outcome.verification !== 'verified') {
      throw new Error('expected verified outcome');
    }
    expect(outcome.acknowledgement).toBe('failed');
    expect(outcome.acknowledgementReason).toBe('google_play_acknowledgement_transport_failed');
    expect(outcome.entitlement?.status).toBe('paid_pending_binding');
    expect(state.acknowledgedTokens.has(token)).toBe(false);

    const entitlements = await database.db
      .select()
      .from(membershipEntitlements)
      .where(eq(membershipEntitlements.accountId, accountAckFail));
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0]?.status).toBe('paid_pending_binding');
  });

  it('treats already-acknowledged purchases as success without re-calling Google mutate when state says so', async () => {
    const state = createFakeGooglePlayAndroidPublisherState();
    const token = 'gp_token_s4_already_ack';
    seedActivePurchase(state, token);
    state.acknowledgedTokens.add(token);
    const adapter = createFakeGooglePlayAndroidPublisherAdapter(state);
    let acknowledgeCalls = 0;
    const originalAcknowledge = adapter.acknowledgeSubscription.bind(adapter);
    adapter.acknowledgeSubscription = (input) => {
      acknowledgeCalls += 1;
      return originalAcknowledge(input);
    };

    const outcome = await verifyAndProvisionGooglePlayPurchase(
      database.db,
      {
        accountId: accountAlreadyAck,
        purchaseToken: token,
        effectiveAt: NOW,
      },
      {
        nodeEnv: 'test',
        processedAt: NOW,
        config: config(true),
        adapter,
      },
    );

    expect(outcome.verification).toBe('verified');
    expect(outcome.result).toBe('applied');
    if (outcome.verification !== 'verified') {
      throw new Error('expected verified outcome');
    }
    expect(outcome.acknowledgement).toBe('already_acknowledged');
    expect(acknowledgeCalls).toBe(0);
  });
});
