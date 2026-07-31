import { execFileSync } from 'node:child_process';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for db:migrate:test`);
  }
  return value;
}

const EXPECTED_TOWN_TABLES = [
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
];

async function assertTownFoundationSchema(pool: Pool): Promise<void> {
  const schemaResult = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.schemata
      WHERE schema_name = 'town'
    ) AS exists`,
  );

  if (schemaResult.rows[0]?.exists !== true) {
    throw new Error('Expected schema "town" to exist after migration');
  }

  const tablesResult = await pool.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'town'
     ORDER BY table_name`,
  );

  const tableNames = tablesResult.rows.map((row) => row.table_name);
  if (JSON.stringify(tableNames) !== JSON.stringify(EXPECTED_TOWN_TABLES)) {
    throw new Error(
      `Expected town identity+civic tables, received: ${tableNames.join(',') || '(none)'}`,
    );
  }

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
  // Note: stripe_customer_links and stripe_checkout_attempts are approved billing tables
  // introduced by the Stripe Billing Runtime slice; only the legacy 'stripe_customers' name is forbidden.

  if (forbidden.rows.length > 0) {
    throw new Error('Forbidden product tables present in town schema');
  }

  const historyResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM drizzle.__drizzle_migrations`,
  );

  if (Number(historyResult.rows[0]?.count ?? 0) < 7) {
    throw new Error('Expected at least seven drizzle migration history rows');
  }
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');

  execFileSync('npx', ['drizzle-kit', 'check'], {
    env: process.env,
    stdio: 'inherit',
  });

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
  });

  try {
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS town CASCADE');

    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
    await assertTownFoundationSchema(pool);

    await migrate(db, { migrationsFolder });
    await assertTownFoundationSchema(pool);

    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS town CASCADE');
    await pool.query('CREATE SCHEMA IF NOT EXISTS town');
    await migrate(db, { migrationsFolder });
    await assertTownFoundationSchema(pool);

    process.stdout.write('db:migrate:test passed\n');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'db:migrate:test failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
