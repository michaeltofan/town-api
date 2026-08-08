import { runFoundationSeedCli } from '../src/db/run-foundation-seed.js';

// Local / CI entrypoint: `tsx scripts/seed-foundation-content.ts`
// No APP_ENV restriction — CI runs this under APP_ENV=test.
runFoundationSeedCli(process.env, { operation: 'db:seed:foundation' });
