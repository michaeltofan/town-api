import { createDatabaseFromEnv } from '../db/client.js';
import { loadEnv } from '../config/env.js';
import { seedFoundationContent } from '../db/seeds/seed-foundation.js';
import { FOUNDATION_COMMUNITIES, FOUNDATION_SIGNALS } from '../db/seeds/foundation-content.js';
import { communities, signals } from '../db/schema.js';
import { count, inArray } from 'drizzle-orm';

// Compiled production entrypoint: `node dist/scripts/seed-foundation-content.js`
// npm run db:seed:foundation:production
//
// Upsert-only: inserts new canonical communities/signals and updates any
// drifted existing rows by ID. Never touches accounts, actors, or
// confirmations, and has no APP_ENV restriction — safe to run repeatedly
// against a live database with real user activity, unlike the staging
// seed runner (db:seed:staging:production), which refuses whenever any
// signal confirmation already exists.
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
  const message = error instanceof Error ? error.message : 'db:seed:foundation:production failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
