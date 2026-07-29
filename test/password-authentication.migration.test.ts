import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

describe('password sign-in migration 0027', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('extends ceremony_rate_limits scope vocabulary without new tables', async () => {
    const check = await pool.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
       WHERE conname = 'ceremony_rate_limits_scope_valid'`,
    );
    const definition = check.rows[0]?.consrc ?? '';
    expect(definition).toContain('password_sign_in_ip');
    expect(definition).toContain('password_sign_in_email');
    expect(definition).toContain('password_setup_grant');
    expect(definition).toContain('passkey_assertion_ip');

    const tables = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'town' AND table_name = 'password_sign_in_attempts'
       ) AS exists`,
    );
    expect(tables.rows[0]?.exists).toBe(false);
  });
});
