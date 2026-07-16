import { createDatabaseFromEnv } from '../src/db/client.js';
import { loadEnv } from '../src/config/env.js';
import { seedFoundationContent } from '../src/db/seeds/seed-foundation.js';
import { FOUNDATION_COMMUNITIES, FOUNDATION_SIGNALS } from '../src/db/seeds/foundation-content.js';
import { communities, signals } from '../src/db/schema.js';
import { count, inArray } from 'drizzle-orm';

async function main(): Promise<void> {
  const env = loadEnv();
  const database = createDatabaseFromEnv(env);

  try {
    await seedFoundationContent(database.db);

    const communityCount = await database.db.select({ value: count() }).from(communities);
    const signalCount = await database.db.select({ value: count() }).from(signals);
    const canonicalSignalCount = await database.db
      .select({ value: count() })
      .from(signals)
      .where(
        inArray(
          signals.id,
          FOUNDATION_SIGNALS.map((signal) => signal.id),
        ),
      );

    process.stdout.write(
      `Foundation seed applied: communities=${String(communityCount[0]?.value ?? 0)} signals=${String(signalCount[0]?.value ?? 0)} canonicalSignals=${String(canonicalSignalCount[0]?.value ?? 0)} expectedCommunities=${String(FOUNDATION_COMMUNITIES.length)} expectedSignals=${String(FOUNDATION_SIGNALS.length)}\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'db:seed:foundation failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
