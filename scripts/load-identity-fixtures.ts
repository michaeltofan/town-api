import { count, eq } from 'drizzle-orm';
import { createDatabaseFromEnv } from '../src/db/client.js';
import { loadEnv } from '../src/config/env.js';
import { accounts, actors, signalConfirmations } from '../src/db/schema.js';
import { CONTROLLED_TEST_ACTOR_ID } from '../src/db/seeds/controlled-actor-content.js';
import { loadIdentityFixtures } from '../src/identity/fixtures/load.js';

/**
 * Test-only fixture loader. Never invoke from application startup.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const database = createDatabaseFromEnv(env);

  try {
    await loadIdentityFixtures(database.db);

    const accountCount = await database.db.select({ value: count() }).from(accounts);
    const controlled = await database.db
      .select()
      .from(actors)
      .where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID));
    const confirmationCount = await database.db
      .select({ value: count() })
      .from(signalConfirmations);

    const controlledAccountId = controlled[0]?.accountId ?? 'null';
    process.stdout.write(
      `Identity fixtures loaded: accounts=${String(accountCount[0]?.value ?? 0)} controlledActorAccountId=${controlledAccountId} confirmations=${String(confirmationCount[0]?.value ?? 0)}\n`,
    );

    if (controlled[0] && controlled[0].accountId !== null) {
      throw new Error('Controlled actor must remain unlinked');
    }
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'identity fixture load failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
