import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

describe('passkey registration migration', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('adds accounts.webauthn_user_handle', async () => {
    const column = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'town'
         AND table_name = 'accounts'
         AND column_name = 'webauthn_user_handle'`,
    );

    expect(column.rows).toHaveLength(1);
  });

  it('adds webauthn_challenges.revoked_at', async () => {
    const column = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'town'
         AND table_name = 'webauthn_challenges'
         AND column_name = 'revoked_at'`,
    );

    expect(column.rows).toHaveLength(1);
  });

  it('allows nullable actor community_id for unassigned civic actors', async () => {
    const column = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'town'
         AND table_name = 'actors'
         AND column_name = 'community_id'`,
    );

    expect(column.rows[0]?.is_nullable).toBe('YES');
  });

  it('keeps the controlled_test actor community constraint', async () => {
    const constraint = await pool.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conrelid = 'town.actors'::regclass
         AND conname = 'actors_controlled_test_requires_community'`,
    );

    expect(constraint.rows).toHaveLength(1);
  });

  it('allows passkey registration failure and account activation event types', async () => {
    const constraint = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conrelid = 'town.identity_security_events'::regclass
         AND conname = 'identity_security_events_type_valid'`,
    );

    expect(constraint.rows[0]?.definition).toContain('passkey_registration_failed');
    expect(constraint.rows[0]?.definition).toContain('account_activated');
  });
});
