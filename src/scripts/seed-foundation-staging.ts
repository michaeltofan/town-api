import { runFoundationSeedCli } from '../db/run-foundation-seed.js';

// Compiled staging entrypoint:
// `node dist/scripts/seed-foundation-staging.js`
// Reuses the atomic foundation upsert, which touches only canonical
// communities and signals. It never truncates tables and does not mutate
// actors, accounts, confirmations, or other civic activity.
runFoundationSeedCli(process.env, {
  operation: 'db:seed:foundation:staging:production',
  requireAppEnv: 'staging',
});
