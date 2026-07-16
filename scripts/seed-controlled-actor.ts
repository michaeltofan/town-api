import { count, eq } from 'drizzle-orm';
import { createDatabaseFromEnv } from '../src/db/client.js';
import { loadEnv } from '../src/config/env.js';
import { actors, signalConfirmations } from '../src/db/schema.js';
import { CONTROLLED_TEST_ACTOR_ID } from '../src/db/seeds/controlled-actor-content.js';
import { seedControlledActor } from '../src/db/seeds/seed-controlled-actor.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const database = createDatabaseFromEnv(env);

  try {
    await seedControlledActor(database.db);

    const actorCount = await database.db.select({ value: count() }).from(actors);
    const controlledCount = await database.db
      .select({ value: count() })
      .from(actors)
      .where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID));
    const confirmationCount = await database.db
      .select({ value: count() })
      .from(signalConfirmations);

    process.stdout.write(
      `Controlled actor seed applied: actors=${String(actorCount[0]?.value ?? 0)} controlledActors=${String(controlledCount[0]?.value ?? 0)} confirmations=${String(confirmationCount[0]?.value ?? 0)}\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'db:seed:controlled-actor failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
