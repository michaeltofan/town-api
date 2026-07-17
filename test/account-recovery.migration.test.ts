import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

describe('account recovery migration', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('adds accounts.recovery_completed_at', async () => {
    const column = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'town'
         AND table_name = 'accounts'
         AND column_name = 'recovery_completed_at'`,
    );
    expect(column.rows).toHaveLength(1);
  });

  it('adds recovery_grants.revoked_at and active grant index', async () => {
    const column = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'town'
         AND table_name = 'recovery_grants'
         AND column_name = 'revoked_at'`,
    );
    expect(column.rows).toHaveLength(1);

    const index = await pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'town'
         AND tablename = 'recovery_grants'
         AND indexname = 'recovery_grants_account_active_idx'`,
    );
    expect(index.rows).toHaveLength(1);
  });

  it('adds recover_account and recover_register active indexes', async () => {
    const emailIdx = await pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'town'
         AND tablename = 'email_challenges'
         AND indexname = 'email_challenges_active_recover_account_idx'`,
    );
    expect(emailIdx.rows).toHaveLength(1);

    const webauthnIdx = await pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'town'
         AND tablename = 'webauthn_challenges'
         AND indexname = 'webauthn_challenges_active_recover_register_idx'`,
    );
    expect(webauthnIdx.rows).toHaveLength(1);
  });

  it('extends ceremony rate-limit scopes and identity security event types', async () => {
    const scope = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conrelid = 'town.ceremony_rate_limits'::regclass
         AND conname = 'ceremony_rate_limits_scope_valid'`,
    );
    expect(scope.rows[0]?.definition).toContain('recovery_email_attempt_challenge');
    expect(scope.rows[0]?.definition).toContain('recovery_email_attempt_email_ip');
    expect(scope.rows[0]?.definition).toContain('recovery_request_email');
    expect(scope.rows[0]?.definition).toContain('setup_options_grant');

    const events = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conrelid = 'town.identity_security_events'::regclass
         AND conname = 'identity_security_events_type_valid'`,
    );
    expect(events.rows[0]?.definition).toContain('recovery_email_verified');
    expect(events.rows[0]?.definition).toContain('recovery_registration_failed');
    expect(events.rows[0]?.definition).toContain('authentication_succeeded');
  });
});
