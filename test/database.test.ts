import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createDatabase } from '../src/db/client.js';
import { loadEnv } from '../src/config/env.js';

function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error('DATABASE_URL must be set for PostgreSQL integration tests');
  }
  return value;
}

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');

describe('PostgreSQL foundation integration', () => {
  const databaseUrl = requireDatabaseUrl();
  let adminPool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    await adminPool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await adminPool.query('DROP SCHEMA IF EXISTS town CASCADE');
  });

  afterAll(async () => {
    await adminPool.end();
  });

  it('applies migrations to a clean database and creates town foundation tables only', async () => {
    const db = drizzle(adminPool);
    await migrate(db, { migrationsFolder });

    const schema = await adminPool.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'town'
      ) AS exists`,
    );
    expect(schema.rows[0]?.exists).toBe(true);

    const tables = await adminPool.query<{ table_name: string }>(
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
      'platform_operators',
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

    const history = await adminPool.query<{ id: number; hash: string }>(
      `SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    );
    expect(history.rows.length).toBeGreaterThanOrEqual(6);
  });

  it('re-applying migrations is safe and does not create forbidden product tables', async () => {
    const db = drizzle(adminPool);
    await migrate(db, { migrationsFolder });
    await migrate(db, { migrationsFolder });

    const tables = await adminPool.query<{ table_name: string }>(
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
      'platform_operators',
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

    const forbidden = await adminPool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'town'
         AND table_name IN ('users', 'confirmations', 'memberships')`,
    );
    expect(forbidden.rows).toEqual([]);
  });

  it('is safe when schema town already exists before Drizzle applies the migration', async () => {
    await adminPool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await adminPool.query('DROP SCHEMA IF EXISTS town CASCADE');
    await adminPool.query('CREATE SCHEMA town');

    const db = drizzle(adminPool);
    await expect(migrate(db, { migrationsFolder })).resolves.toBeUndefined();

    const schema = await adminPool.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'town'
      ) AS exists`,
    );
    expect(schema.rows[0]?.exists).toBe(true);

    const tables = await adminPool.query<{ table_name: string }>(
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
      'platform_operators',
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

    const history = await adminPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(history.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(6);
  });

  it('db:check succeeds against committed migrations', () => {
    execFileSync('npx', ['drizzle-kit', 'check'], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
      stdio: 'pipe',
    });
  });

  it('creates a pool with valid config, readiness succeeds, and close is idempotent', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      DB_POOL_MAX: '2',
      DB_CONNECTION_TIMEOUT_MS: '3000',
      DB_IDLE_TIMEOUT_MS: '1000',
    });

    const database = createDatabase({
      connectionString: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
    });

    await expect(database.checkReadiness()).resolves.toBe(true);
    await expect(database.close()).resolves.toBeUndefined();
    await expect(database.close()).resolves.toBeUndefined();
  });

  it('readiness failure is handled for unreachable database', async () => {
    const database = createDatabase({
      connectionString: 'postgres://town_test:town_test@127.0.0.1:1/does_not_exist',
      poolMax: 1,
      connectionTimeoutMs: 500,
      idleTimeoutMs: 500,
    });

    await expect(database.checkReadiness()).resolves.toBe(false);
    await expect(database.close()).resolves.toBeUndefined();
  });

  it('does not open connections during module import', async () => {
    const before = await adminPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_stat_activity WHERE datname = current_database()`,
    );

    await import('../src/db/client.js');
    await import('../src/db/lifecycle.js');
    await import('../src/db/schema.js');

    const after = await adminPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_stat_activity WHERE datname = current_database()`,
    );

    expect(Number(after.rows[0]?.count)).toBe(Number(before.rows[0]?.count));
  });
});
