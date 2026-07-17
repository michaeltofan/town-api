import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

describe('passkey authentication migration', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('adds passkey_credentials.backup_eligible', async () => {
    const column = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'town'
         AND table_name = 'passkey_credentials'
         AND column_name = 'backup_eligible'`,
    );

    expect(column.rows).toHaveLength(1);
  });

  it('adds the active authenticate challenge index', async () => {
    const index = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'town'
         AND tablename = 'webauthn_challenges'
         AND indexname = 'webauthn_challenges_active_authenticate_idx'`,
    );

    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]?.indexdef).toContain('purpose');
    expect(index.rows[0]?.indexdef).toContain('expires_at');
    expect(index.rows[0]?.indexdef).toContain("purpose = 'authenticate'");
  });

  it('allows passkey authentication success security events', async () => {
    const constraint = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conrelid = 'town.identity_security_events'::regclass
         AND conname = 'identity_security_events_type_valid'`,
    );

    expect(constraint.rows[0]?.definition).toContain('authentication_succeeded');
    expect(constraint.rows[0]?.definition).toContain('counter_anomaly_detected');
  });
});
