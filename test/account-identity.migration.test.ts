import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

const EXPECTED_TABLES = [
  'account_emails',
  'account_sessions',
  'accounts',
  'actors',
  'ceremony_rate_limits',
  'communities',
  'email_challenges',
  'google_play_purchase_links',
  'identity_security_events',
  'membership_entitlements',
  'membership_source_events',
  'passkey_credentials',
  'recovery_grants',
  'setup_grants',
  'signal_confirmations',
  'signal_submissions',
  'signals',
  'stripe_checkout_attempts',
  'stripe_customer_links',
  'webauthn_challenges',
];

describe('account identity migration', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates identity tables, actors.account_id, and RESTRICT foreign keys', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'town'
       ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(EXPECTED_TABLES);

    const accountIdColumn = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'town' AND table_name = 'actors' AND column_name = 'account_id'`,
    );
    expect(accountIdColumn.rows).toHaveLength(1);

    const fks = await pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND contype = 'f'
         AND conname IN (
           'account_emails_account_id_fkey',
           'passkey_credentials_account_id_fkey',
           'email_challenges_account_id_fkey',
           'recovery_grants_account_id_fkey',
           'webauthn_challenges_account_id_fkey',
           'identity_security_events_account_id_fkey',
           'actors_account_id_fkey'
         )
       ORDER BY conname`,
    );
    expect(fks.rows).toHaveLength(7);
    for (const row of fks.rows) {
      expect(row.confdeltype).toBe('r');
    }

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'town' ORDER BY indexname`,
    );
    const indexNames = indexes.rows.map((row) => row.indexname);
    expect(indexNames).toEqual(
      expect.arrayContaining([
        'account_emails_active_normalized_unique',
        'account_emails_one_active_primary',
        'actors_account_id_unique',
      ]),
    );
  });

  it('does not create membership, payment, stripe, or session tables', async () => {
    const forbidden = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'town'
         AND table_name IN (
           'users',
           'memberships',
           'sessions',
           'payments',
           'stripe_customers',
           'passwords'
         )`,
    );
    expect(forbidden.rows).toEqual([]);
  });
});
