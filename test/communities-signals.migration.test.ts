import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrationsFolder, requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

describe('communities and signals migration', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates town.communities and town.signals with required constraints and index', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'town'
       ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'account_emails',
      'account_sessions',
      'accounts',
      'actors',
      'ceremony_rate_limits',
      'communities',
      'email_challenges',
      'identity_security_events',
      'membership_entitlements',
      'membership_source_events',
      'passkey_credentials',
      'recovery_grants',
      'setup_grants',
      'signal_confirmations',
      'signals',
      'webauthn_challenges',
    ]);

    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
       ORDER BY conname`,
    );
    const names = constraints.rows.map((row) => row.conname);
    expect(names).toEqual(
      expect.arrayContaining([
        'communities_pkey',
        'communities_slug_unique',
        'communities_position_unique',
        'communities_position_positive',
        'communities_country_code_length',
        'communities_status_active',
        'signals_pkey',
        'signals_community_id_fkey',
        'signals_community_slug_unique',
        'signals_community_position_unique',
        'signals_position_positive',
        'signals_publication_status_published',
        'signals_observed_precision_valid',
        'signals_image_focus_x_range',
        'signals_image_focus_y_range',
      ]),
    );

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'town'
       ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain(
      'signals_community_publication_position_idx',
    );
  });

  it('does not create users, confirmations, or memberships tables', async () => {
    const forbidden = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'town'
         AND table_name IN ('users', 'confirmations', 'memberships', 'sessions', 'passwords')`,
    );
    expect(forbidden.rows).toEqual([]);
  });

  it('keeps prior town schema migration intact and re-applies safely', async () => {
    const schema = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'town'
      ) AS exists`,
    );
    expect(schema.rows[0]?.exists).toBe(true);

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
      'account_sessions',
      'accounts',
      'actors',
      'ceremony_rate_limits',
      'communities',
      'email_challenges',
      'identity_security_events',
      'membership_entitlements',
      'membership_source_events',
      'passkey_credentials',
      'recovery_grants',
      'setup_grants',
      'signal_confirmations',
      'signals',
      'webauthn_challenges',
    ]);
  });
});
