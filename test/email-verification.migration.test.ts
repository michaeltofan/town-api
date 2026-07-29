import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

describe('email verification migration', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('adds email_challenges.revoked_at without removing prior tables', async () => {
    const column = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'town'
         AND table_name = 'email_challenges'
         AND column_name = 'revoked_at'`,
    );
    expect(column.rows).toHaveLength(1);

    const history = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(history.rows[0]?.count)).toBeGreaterThanOrEqual(6);

    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'town'
         AND indexname IN (
           'account_emails_normalized_unique',
           'account_emails_active_normalized_unique'
         )
       ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(['account_emails_normalized_unique']);
    expect(indexes.rows[0]?.indexdef).toMatch(/UNIQUE INDEX.*email_normalized/i);
    expect(indexes.rows[0]?.indexdef).not.toMatch(/revoked_at/i);

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'town'
         AND table_name IN ('setup_grants', 'account_sessions', 'ceremony_rate_limits', 'email_challenges')
       ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'account_sessions',
      'ceremony_rate_limits',
      'email_challenges',
      'setup_grants',
    ]);
  });

  it('fails safely on simulated pre-existing normalized collisions without selecting an account', async () => {
    await pool.query(`DROP SCHEMA IF EXISTS drizzle CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS town CASCADE`);
    await pool.query(`CREATE SCHEMA town`);
    await pool.query(`CREATE TABLE town.accounts (
      id uuid PRIMARY KEY,
      status text NOT NULL
    )`);
    await pool.query(`CREATE TABLE town.account_emails (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES town.accounts(id),
      email_normalized text NOT NULL,
      revoked_at timestamptz
    )`);
    // Simulate legacy partial-unique world with two accounts sharing one normalized email.
    await pool.query(`INSERT INTO town.accounts (id, status) VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'closed'),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'pending_email')`);
    await pool.query(`INSERT INTO town.account_emails (id, account_id, email_normalized, revoked_at) VALUES
      ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'collision@example.com', now()),
      ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'collision@example.com', null)`);

    let failed = false;
    let message = '';
    try {
      await pool.query(`
        DO $$
        DECLARE
          collision_groups integer;
        BEGIN
          SELECT COUNT(*)::integer INTO collision_groups
          FROM (
            SELECT 1
            FROM town.account_emails
            GROUP BY email_normalized
            HAVING COUNT(*) > 1
          ) AS collisions;
          IF collision_groups > 0 THEN
            RAISE EXCEPTION 'account_emails exact normalized identity collision detected; refusing permanent uniqueness without historical repair';
          END IF;
        END $$;
      `);
    } catch (error) {
      failed = true;
      message = error instanceof Error ? error.message : String(error);
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/exact normalized identity collision detected/i);
    expect(message).not.toMatch(/collision@example\.com/i);
    expect(message).not.toMatch(/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/);
    expect(message).not.toMatch(/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/);

    // Re-apply full migration set for subsequent tests in this file / suite reuse.
    await resetAndMigrate(pool);
  });
});
