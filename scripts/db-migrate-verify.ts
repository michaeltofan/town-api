import { Pool } from 'pg';
import { checkMigrationLedger, EXPECTED_MIGRATION_COUNT } from '../src/db/migration-ledger.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for db:migrate:verify');
  }

  const readinessTimeoutMs = Number.parseInt(process.env.READINESS_TIMEOUT_MS ?? '5000', 10);
  const timeoutMs =
    Number.isFinite(readinessTimeoutMs) && readinessTimeoutMs > 0 ? readinessTimeoutMs : 5000;

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  try {
    const result = await checkMigrationLedger(pool, { timeoutMs });
    const payload = {
      status: result.status,
      expected: result.expected,
      applied: result.applied,
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    if (result.status !== 'ok') {
      process.stderr.write(
        `Migration verify failed: status=${result.status} expected=${String(result.expected)} applied=${String(result.applied)}\n`,
      );
      process.exit(1);
    }
    if (result.applied !== EXPECTED_MIGRATION_COUNT) {
      process.stderr.write(
        `Migration verify failed: applied count does not match expected constant\n`,
      );
      process.exit(1);
    }
    process.stdout.write('Migration ledger OK\n');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Migration verify failed';
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
