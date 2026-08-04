import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

const EXPECTED_TABLES = [
  'account_emails',
  'account_password_credentials',
  'account_sessions',
  'accounts',
  'actors',
  'ceremony_rate_limits',
  'civic_action_updates',
  'civic_deliberation_contributions',
  'civic_mandates',
  'civic_process_events',
  'civic_process_transitions',
  'civic_processes',
  'civic_proposals',
  'civic_votes',
  'communities',
  'email_challenges',
  'google_play_purchase_links',
  'google_play_rtdn_inbox',
  'identity_security_events',
  'membership_entitlements',
  'membership_source_events',
  'passkey_credentials',
  'platform_alerts',
  'platform_audit_events',
  'platform_backup_verifications',
  'platform_operators',
  'platform_restore_drill_attestations',
  'platform_technical_errors',
  'platform_uptime_samples',
  'recovery_grants',
  'setup_grants',
  'signal_confirmations',
  'signal_discussion_contributions',
  'signal_discussion_media_uploads',
  'signal_discussion_sessions',
  'signal_media_uploads',
  'signal_submissions',
  'signals',
  'stripe_checkout_attempts',
  'stripe_customer_links',
  'webauthn_challenges',
];

describe('authentication ceremony migration', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates ceremony tables, extends event types, and keeps civic/identity intact', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'town'
       ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(EXPECTED_TABLES);

    const fks = await pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND contype = 'f'
         AND conname IN (
           'setup_grants_account_id_fkey',
           'account_sessions_account_id_fkey'
         )
       ORDER BY conname`,
    );
    expect(fks.rows).toHaveLength(2);
    for (const row of fks.rows) {
      expect(row.confdeltype).toBe('r');
    }

    const uniques = await pool.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND contype = 'u'
         AND conname IN (
           'setup_grants_token_hash_unique',
           'account_sessions_token_hash_unique',
           'ceremony_rate_limits_bucket_unique'
         )
       ORDER BY conname`,
    );
    expect(uniques.rows.map((row) => row.conname)).toEqual([
      'account_sessions_token_hash_unique',
      'ceremony_rate_limits_bucket_unique',
      'setup_grants_token_hash_unique',
    ]);

    const sessionChecks = await pool.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND contype = 'c'
         AND conname LIKE 'account_sessions_%'
       ORDER BY conname`,
    );
    expect(sessionChecks.rows.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        'account_sessions_idle_within_absolute',
        'account_sessions_revocation_reason_consistency',
        'account_sessions_client_type_valid',
      ]),
    );

    const eventCheck = await pool.query<{ consrc: string | null; conname: string }>(
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS consrc
       FROM pg_constraint c
       WHERE c.connamespace = 'town'::regnamespace
         AND c.conname = 'identity_security_events_type_valid'`,
    );
    expect(eventCheck.rows).toHaveLength(1);
    expect(eventCheck.rows[0]?.consrc).toContain('session_created');
    expect(eventCheck.rows[0]?.consrc).toContain('rate_limit_triggered');
    expect(eventCheck.rows[0]?.consrc).toContain('email_verified');

    const rawColumns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'town'
         AND (
           (table_name = 'setup_grants' AND column_name IN ('token', 'raw_token'))
           OR (table_name = 'account_sessions' AND column_name IN ('token', 'raw_token', 'session_token'))
           OR (
             table_name = 'ceremony_rate_limits'
             AND column_name IN ('email', 'ip', 'ip_address', 'credential_id', 'subject')
           )
         )`,
    );
    expect(rawColumns.rows).toEqual([]);
  });

  it('does not create membership, stripe, payment, local verification, or generic sessions tables', async () => {
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
           'passwords',
           'local_verifications',
           'cookies'
         )`,
    );
    expect(forbidden.rows).toEqual([]);
  });
});
