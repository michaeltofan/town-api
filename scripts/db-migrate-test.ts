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

async function assertTownSchemaOnly(pool: Pool): Promise<void> {
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

  if (tablesResult.rows.length > 0) {
    throw new Error('Expected no product tables in schema "town"');
  }

  const historyResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM drizzle.__drizzle_migrations`,
  );

  if (Number(historyResult.rows[0]?.count ?? 0) < 1) {
    throw new Error('Expected drizzle migration history rows');
  }
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');

  // Validate committed migration history consistency without applying.
  execFileSync('npx', ['drizzle-kit', 'check'], {
    env: process.env,
    stdio: 'inherit',
  });

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
  });

  try {
    // Reset public/drizzle state for a clean migration test database.
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS town CASCADE');

    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
    await assertTownSchemaOnly(pool);

    // Re-applying must be safe and must not create duplicate schema objects.
    await migrate(db, { migrationsFolder });
    await assertTownSchemaOnly(pool);

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
