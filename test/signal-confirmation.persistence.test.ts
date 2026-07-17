import { describe, expect, it } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { actors, signalConfirmations } from '../src/db/schema.js';
import { CONTROLLED_TEST_ACTOR_ID } from '../src/db/seeds/controlled-actor-content.js';
import { FOUNDATION_SIGNAL_IDS } from '../src/db/seeds/foundation-content.js';
import { createInMemoryTestDeliveryAdapter } from '../src/ceremony/email-verification/delivery.js';
import { createPasskeyAuthenticationEnv } from './helpers/passkey-authentication.js';
import {
  activatePasskeyAccountAndLinkCommunity,
  activateTestMembership,
  createEligibleTestResolver,
} from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

/**
 * The participant PUT confirmation persists across app instance recreation and
 * confirmation history is always attributed to the linked civic actor — never to
 * the controlled test actor.
 */
describe('confirmation persistence after restart (participant PUT)', () => {
  it('keeps confirmed state and confirmedAt across app instance recreation', async () => {
    const databaseUrl = requireDatabaseUrl();
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetMigrateSeedFoundationAndActor(pool);

    const env = createPasskeyAuthenticationEnv();
    const delivery = createInMemoryTestDeliveryAdapter();
    const resolver = createEligibleTestResolver();

    const databaseA = createDatabase({
      connectionString: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
    });
    const appA = await buildApp({
      env,
      logger: false,
      database: databaseA,
      emailVerification: { deliveryAdapter: delivery },
      membership: { localEligibilityResolver: resolver },
    });
    await appA.ready();

    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: appA,
      delivery,
      email: 'ConfirmationPersistence+setup@example.com',
    });
    await activateTestMembership(appA, {
      accountId: registration.accountId,
      effectiveAt: '2026-07-17T12:00:00.000Z',
      accessUntil: '2030-01-01T00:00:00.000Z',
    });
    const login = await loginMobileSession({ app: appA, material: registration.material });

    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;
    const put = await appA.inject({
      method: 'PUT',
      url: `/v1/signals/${signalId}/confirmation`,
      headers: {
        authorization: `Session ${login.sessionToken}`,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(put.statusCode).toBe(200);
    const putBody = put.json<{ data: { confirmedAt: string } }>();
    const confirmedAt = putBody.data.confirmedAt;

    // Confirmation row is attributed to the linked civic actor, not the controlled actor.
    const rows = await databaseA.db
      .select()
      .from(signalConfirmations)
      .where(eq(signalConfirmations.signalId, signalId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorId).toBe(registration.actorId);
    expect(rows[0]?.actorId).not.toBe(CONTROLLED_TEST_ACTOR_ID);

    // Total rows attributable to the controlled actor remains zero.
    const controlledRows = await databaseA.db
      .select({ value: count() })
      .from(signalConfirmations)
      .where(eq(signalConfirmations.actorId, CONTROLLED_TEST_ACTOR_ID));
    expect(controlledRows[0]?.value).toBe(0);

    await appA.close();
    await databaseA.close();

    const databaseB = createDatabase({
      connectionString: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
    });
    const appB = await buildApp({
      env,
      logger: false,
      database: databaseB,
      emailVerification: { deliveryAdapter: delivery },
      membership: { localEligibilityResolver: resolver },
    });
    await appB.ready();

    try {
      // The persisted confirmation row still exists and is unchanged after restart.
      const rowsB = await databaseB.db
        .select()
        .from(signalConfirmations)
        .where(eq(signalConfirmations.signalId, signalId));
      expect(rowsB).toHaveLength(1);
      const dbConfirmedAt = rowsB[0]?.confirmedAt;
      if (!dbConfirmedAt) {
        throw new Error('confirmedAt should be present in persisted row');
      }
      expect(new Date(dbConfirmedAt).toISOString()).toBe(confirmedAt);
      expect(rowsB[0]?.actorId).toBe(registration.actorId);

      // The controlled actor is still unlinked and has no confirmations.
      const controlled = await databaseB.db
        .select()
        .from(actors)
        .where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID))
        .limit(1);
      expect(controlled[0]?.accountId).toBeNull();
      const controlledRowsAfter = await databaseB.db
        .select({ value: count() })
        .from(signalConfirmations)
        .where(
          and(
            eq(signalConfirmations.signalId, signalId),
            eq(signalConfirmations.actorId, CONTROLLED_TEST_ACTOR_ID),
          ),
        );
      expect(controlledRowsAfter[0]?.value).toBe(0);
    } finally {
      await appB.close();
      await databaseB.close();
      await pool.end();
    }
  });
});
