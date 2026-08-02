import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrationsFolder, requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

describe('actors and signal_confirmations migration', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates actors and signal_confirmations with required constraints', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'town'
       ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'account_emails',
      'account_password_credentials',
      'account_sessions',
      'accounts',
      'actors',
      'ceremony_rate_limits',
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
    ]);

    const constraints = await pool.query<{ conname: string; contype: string }>(
      `SELECT conname, contype
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
       ORDER BY conname`,
    );
    const names = constraints.rows.map((row) => row.conname);
    expect(names).toEqual(
      expect.arrayContaining([
        'actors_pkey',
        'actors_community_id_fkey',
        'actors_kind_valid',
        'actors_status_active',
        'signal_confirmations_pkey',
        'signal_confirmations_signal_id_fkey',
        'signal_confirmations_actor_id_fkey',
        'signal_confirmations_signal_actor_unique',
        'communities_pkey',
        'signals_pkey',
      ]),
    );

    const fkDelete = await pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND contype = 'f'
         AND conname IN (
           'actors_community_id_fkey',
           'signal_confirmations_signal_id_fkey',
           'signal_confirmations_actor_id_fkey'
         )
       ORDER BY conname`,
    );
    expect(fkDelete.rows).toHaveLength(3);
    for (const row of fkDelete.rows) {
      // PostgreSQL stores RESTRICT as 'r'
      expect(row.confdeltype).toBe('r');
    }
  });

  it('does not create auth, membership, or payment tables', async () => {
    const forbidden = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'town'
         AND table_name IN (
           'users',
           'confirmations',
           'memberships',
           'sessions',
           'payments',
           'stripe_customers',
           'passwords'
         )`,
    );
    expect(forbidden.rows).toEqual([]);
  });

  it('keeps prior communities/signals migrations intact and re-applies safely', async () => {
    const history = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(history.rows[0]?.count)).toBeGreaterThanOrEqual(6);

    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'town' ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'account_emails',
      'account_password_credentials',
      'account_sessions',
      'accounts',
      'actors',
      'ceremony_rate_limits',
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
    ]);
  });
});
