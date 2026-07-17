import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetAndMigrate } from './helpers/pg.js';

describe('passkey management migration', () => {
  const databaseUrl = requireDatabaseUrl();
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetAndMigrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('adds passkey_credentials.public_id as not null unique', async () => {
    const column = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'town'
         AND table_name = 'passkey_credentials'
         AND column_name = 'public_id'`,
    );
    expect(column.rows).toHaveLength(1);
    expect(column.rows[0]?.is_nullable).toBe('NO');

    const unique = await pool.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conrelid = 'town.passkey_credentials'::regclass
         AND conname = 'passkey_credentials_public_id_unique'`,
    );
    expect(unique.rows).toHaveLength(1);
  });

  it('tightens label length to 64 and adds revocation_reason', async () => {
    const label = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conrelid = 'town.passkey_credentials'::regclass
         AND conname = 'passkey_credentials_label_length'`,
    );
    expect(label.rows[0]?.definition).toContain('64');
    expect(label.rows[0]?.definition).not.toContain('128');

    const reason = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conrelid = 'town.passkey_credentials'::regclass
         AND conname = 'passkey_credentials_revocation_reason_valid'`,
    );
    expect(reason.rows[0]?.definition).toContain('user_requested');
  });

  it('adds session freshness and authenticated passkey columns', async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'town'
         AND table_name = 'account_sessions'
         AND column_name in ('authenticated_passkey_id', 'fresh_authenticated_at')
       ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'authenticated_passkey_id',
      'fresh_authenticated_at',
    ]);
  });

  it('adds webauthn challenge session_id and manage purposes', async () => {
    const column = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'town'
         AND table_name = 'webauthn_challenges'
         AND column_name = 'session_id'`,
    );
    expect(column.rows).toHaveLength(1);

    const purpose = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conrelid = 'town.webauthn_challenges'::regclass
         AND conname = 'webauthn_challenges_purpose_valid'`,
    );
    expect(purpose.rows[0]?.definition).toContain('manage_passkeys_authenticate');
    expect(purpose.rows[0]?.definition).toContain('manage_passkeys_register');

    const index = await pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'town'
         AND tablename = 'webauthn_challenges'
         AND indexname = 'webauthn_challenges_active_manage_session_idx'`,
    );
    expect(index.rows).toHaveLength(1);
  });

  it('extends rate-limit scopes and security event types', async () => {
    const scopes = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conrelid = 'town.ceremony_rate_limits'::regclass
         AND conname = 'ceremony_rate_limits_scope_valid'`,
    );
    expect(scopes.rows[0]?.definition).toContain('passkey_inventory_account');
    expect(scopes.rows[0]?.definition).toContain('passkey_reauthentication_options_session');
    expect(scopes.rows[0]?.definition).toContain('passkey_revoke_account');

    const events = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conrelid = 'town.identity_security_events'::regclass
         AND conname = 'identity_security_events_type_valid'`,
    );
    expect(events.rows[0]?.definition).toContain('passkey_inventory_viewed');
    expect(events.rows[0]?.definition).toContain('passkey_management_changed');
    expect(events.rows[0]?.definition).toContain('passkey_reauthentication_started');
    expect(events.rows[0]?.definition).toContain('passkey_reauthentication_succeeded');
    expect(events.rows[0]?.definition).toContain('passkey_renamed');
  });

  it('extends session revocation reasons with passkey_added and passkey_revoked', async () => {
    const reason = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'town'::regnamespace
         AND conrelid = 'town.account_sessions'::regclass
         AND conname = 'account_sessions_revocation_reason_valid'`,
    );
    expect(reason.rows[0]?.definition).toContain('passkey_added');
    expect(reason.rows[0]?.definition).toContain('passkey_revoked');
  });
});
