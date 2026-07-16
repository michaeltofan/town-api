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
  if (
    JSON.stringify(tableNames) !==
    JSON.stringify(['actors', 'communities', 'signal_confirmations', 'signals'])
  ) {
    throw new Error(
      `Expected town.actors, town.communities, town.signal_confirmations, and town.signals, received: ${tableNames.join(',') || '(none)'}`,
    );
  }

  const forbidden = await pool.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'town'
       AND table_name IN ('users', 'confirmations', 'memberships', 'accounts', 'sessions')`,
  );

  if (forbidden.rows.length > 0) {
    throw new Error('Forbidden product tables present in town schema');
  }

  const historyResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM drizzle.__drizzle_migrations`,
  );

  if (Number(historyResult.rows[0]?.count ?? 0) < 3) {
    throw new Error('Expected at least three drizzle migration history rows');
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
