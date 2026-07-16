import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDatabase, type Database } from '../src/db/client.js';
import {
  accountEmails,
  accounts,
  actors,
  emailChallenges,
  identitySecurityEvents,
  passkeyCredentials,
  recoveryGrants,
  signalConfirmations,
  webauthnChallenges,
} from '../src/db/schema.js';
import { CONTROLLED_TEST_ACTOR_ID } from '../src/db/seeds/controlled-actor-content.js';
import {
  IDENTITY_ACCOUNT_IDS,
  IDENTITY_ACTOR_IDS,
  IDENTITY_FIXTURE_TIMESTAMPS,
} from '../src/identity/fixtures/content.js';
import { loadIdentityFixtures } from '../src/identity/fixtures/load.js';
import { toIsoTimestamp } from '../src/lib/timestamps.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

describe('account identity fixtures', () => {
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
    await loadIdentityFixtures(database.db);
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it('loads deterministic fixture counts without linking the controlled actor', async () => {
    expect((await database.db.select({ value: count() }).from(accounts))[0]?.value).toBe(5);
    expect((await database.db.select({ value: count() }).from(accountEmails))[0]?.value).toBe(5);
    expect((await database.db.select({ value: count() }).from(passkeyCredentials))[0]?.value).toBe(
      4,
    );
    expect((await database.db.select({ value: count() }).from(emailChallenges))[0]?.value).toBe(2);
    expect((await database.db.select({ value: count() }).from(webauthnChallenges))[0]?.value).toBe(
      2,
    );
    expect((await database.db.select({ value: count() }).from(recoveryGrants))[0]?.value).toBe(1);
    expect(
      (await database.db.select({ value: count() }).from(identitySecurityEvents))[0]?.value,
    ).toBe(4);

    const controlled = await database.db
      .select()
      .from(actors)
      .where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID));
    expect(controlled).toHaveLength(1);
    expect(controlled[0]?.accountId).toBeNull();
    expect(controlled[0]?.kind).toBe('controlled_test');

    const linked = await database.db
      .select()
      .from(actors)
      .where(eq(actors.id, IDENTITY_ACTOR_IDS.activeLinked));
    expect(linked[0]?.accountId).toBe(IDENTITY_ACCOUNT_IDS.active);
    expect(linked[0]?.kind).toBe('civic');

    const active = await database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, IDENTITY_ACCOUNT_IDS.active));
    expect(active[0]?.status).toBe('active');
    expect(active[0]?.accountReadyAt).toBeTruthy();
    expect(toIsoTimestamp(String(active[0]?.accountReadyAt))).toBe(IDENTITY_FIXTURE_TIMESTAMPS.t3);

    expect((await database.db.select({ value: count() }).from(signalConfirmations))[0]?.value).toBe(
      0,
    );
  });

  it('does not create membership, session, or stripe tables via fixtures', async () => {
    const forbidden = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'town'
         AND table_name IN ('memberships', 'sessions', 'stripe_customers', 'payments')`,
    );
    expect(forbidden.rows).toEqual([]);
  });
});
