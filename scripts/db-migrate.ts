import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for db:migrate');
  }

  const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
  });

  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
    process.stdout.write('Migrations applied successfully\n');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Migration failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
