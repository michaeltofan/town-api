import { createDatabaseFromEnv } from '../src/db/client.js';
import { loadEnv } from '../src/config/env.js';
import { loadCeremonyFixtures } from '../src/ceremony/fixtures/load.js';

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  const database = createDatabaseFromEnv(env);
  try {
    await loadCeremonyFixtures(database.db);
    process.stdout.write('Ceremony fixtures loaded\n');
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Failed to load ceremony fixtures';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
