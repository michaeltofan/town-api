import { runSeedModerationFixturesCli } from '../src/platform/run-seed-moderation-fixtures.js';

// Staging-only:
// APP_ENV=staging DATABASE_URL=... \
//   npx tsx scripts/seed-platform-moderation-fixtures.ts \
//   --mode create --account-id <uuid>
//
// Cleanup:
// APP_ENV=staging DATABASE_URL=... \
//   npx tsx scripts/seed-platform-moderation-fixtures.ts \
//   --mode cleanup --account-id <uuid>
await runSeedModerationFixturesCli();
