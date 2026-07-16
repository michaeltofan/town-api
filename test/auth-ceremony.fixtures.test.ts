import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import {
  CEREMONY_ACCOUNT_IDS,
  CEREMONY_EVENT_IDS,
  CEREMONY_FIXTURE_TIMESTAMPS,
  CEREMONY_HASHES,
  CEREMONY_RATE_LIMIT_IDS,
  CEREMONY_SESSION_IDS,
  CEREMONY_SETUP_GRANT_IDS,
} from '../src/ceremony/fixtures/content.js';
import { loadCeremonyFixtures } from '../src/ceremony/fixtures/load.js';
import {
  findActiveAccountSessionByTokenHash,
  sessionSupportsSensitiveOperation,
} from '../src/ceremony/repositories/account-sessions.js';
import { isCeremonyRateLimitBlocked } from '../src/ceremony/repositories/ceremony-rate-limits.js';
import { findActiveSetupGrantByTokenHash } from '../src/ceremony/repositories/setup-grants.js';
import { createDatabase, type Database } from '../src/db/client.js';
import {
  accountSessions,
  actors,
  ceremonyRateLimits,
  identitySecurityEvents,
  setupGrants,
  signalConfirmations,
} from '../src/db/schema.js';
import { CONTROLLED_TEST_ACTOR_ID } from '../src/db/seeds/controlled-actor-content.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

describe('authentication ceremony fixtures', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;
  let database: Database;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetMigrateSeedFoundationAndActor(pool);
    database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 5,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    await loadCeremonyFixtures(database.db);
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it('loads deterministic ceremony fixture counts and states', async () => {
    expect((await database.db.select({ value: count() }).from(setupGrants))[0]?.value).toBe(4);
    expect((await database.db.select({ value: count() }).from(accountSessions))[0]?.value).toBe(7);
    expect((await database.db.select({ value: count() }).from(ceremonyRateLimits))[0]?.value).toBe(
      4,
    );

    const now = CEREMONY_FIXTURE_TIMESTAMPS.now;
    await expect(
      findActiveSetupGrantByTokenHash(database.db, {
        tokenHash: CEREMONY_HASHES.setupActive,
        purpose: 'initial_passkey_registration',
        now,
      }),
    ).resolves.toMatchObject({ id: CEREMONY_SETUP_GRANT_IDS.active });

    await expect(
      findActiveSetupGrantByTokenHash(database.db, {
        tokenHash: CEREMONY_HASHES.setupExpired,
        purpose: 'initial_passkey_registration',
        now,
      }),
    ).rejects.toMatchObject({ code: 'SETUP_GRANT_EXPIRED' });

    await expect(
      findActiveAccountSessionByTokenHash(database.db, {
        tokenHash: CEREMONY_HASHES.sessionWeb,
        now,
      }),
    ).resolves.toMatchObject({ id: CEREMONY_SESSION_IDS.activeWeb, clientType: 'web' });

    await expect(
      findActiveAccountSessionByTokenHash(database.db, {
        tokenHash: CEREMONY_HASHES.sessionMobile,
        now,
      }),
    ).resolves.toMatchObject({ id: CEREMONY_SESSION_IDS.activeMobile, clientType: 'mobile' });

    await expect(
      findActiveAccountSessionByTokenHash(database.db, {
        tokenHash: CEREMONY_HASHES.sessionIdleExpired,
        now,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_IDLE_EXPIRED' });

    await expect(
      findActiveAccountSessionByTokenHash(database.db, {
        tokenHash: CEREMONY_HASHES.sessionAbsoluteExpired,
        now,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_ABSOLUTE_EXPIRED' });

    const fresh = await findActiveAccountSessionByTokenHash(database.db, {
      tokenHash: CEREMONY_HASHES.sessionSensitiveFresh,
      now,
    });
    const stale = await findActiveAccountSessionByTokenHash(database.db, {
      tokenHash: CEREMONY_HASHES.sessionSensitiveStale,
      now,
    });
    expect(sessionSupportsSensitiveOperation(fresh, now)).toBe(true);
    expect(sessionSupportsSensitiveOperation(stale, now)).toBe(false);
    expect(stale.recoveryRecentAt).not.toBe(stale.authenticatedAt);

    expect(
      await isCeremonyRateLimitBlocked(database.db, {
        id: CEREMONY_RATE_LIMIT_IDS.blocked,
        now,
      }),
    ).toBe(true);

    const eventTypes = (
      await database.db
        .select()
        .from(identitySecurityEvents)
        .where(eq(identitySecurityEvents.accountId, CEREMONY_ACCOUNT_IDS.active))
    ).map((row) => row.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        'session_created',
        'session_rotated',
        'session_revoked',
        'rate_limit_triggered',
      ]),
    );
    expect(eventTypes).toContain(
      (
        await database.db
          .select()
          .from(identitySecurityEvents)
          .where(eq(identitySecurityEvents.id, CEREMONY_EVENT_IDS.sessionCreated))
      )[0]?.eventType,
    );
  });

  it('does not modify controlled actor or confirmation ownership', async () => {
    const controlled = await database.db
      .select()
      .from(actors)
      .where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID));
    expect(controlled).toHaveLength(1);
    expect(controlled[0]?.accountId).toBeNull();

    expect((await database.db.select({ value: count() }).from(signalConfirmations))[0]?.value).toBe(
      0,
    );

    const forbidden = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'town'
         AND table_name IN ('memberships', 'sessions', 'stripe_customers', 'payments', 'local_verifications')`,
    );
    expect(forbidden.rows).toEqual([]);
  });
});
