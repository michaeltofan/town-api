import { runFoundationSeedCli } from '../db/run-foundation-seed.js';

// Compiled production entrypoint: `node dist/scripts/seed-foundation-content.js`
// npm run db:seed:foundation:production
// Refuses unless APP_ENV=production.
runFoundationSeedCli(process.env, {
  operation: 'db:seed:foundation:production',
  requireAppEnv: 'production',
});
