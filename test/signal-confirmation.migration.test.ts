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
      'actors',
      'communities',
      'signal_confirmations',
      'signals',
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
        'actors_kind_controlled_test',
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
           'accounts',
           'sessions',
           'payments',
           'stripe_customers'
         )`,
    );
    expect(forbidden.rows).toEqual([]);
  });

  it('keeps prior communities/signals migrations intact and re-applies safely', async () => {
    const history = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(history.rows[0]?.count)).toBeGreaterThanOrEqual(3);

    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'town' ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'actors',
      'communities',
      'signal_confirmations',
      'signals',
    ]);
  });
});
