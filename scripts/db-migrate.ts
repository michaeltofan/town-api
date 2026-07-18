import { runMigrationsCli } from '../src/db/run-migrations.js';

// Local / CI entrypoint: `tsx scripts/db-migrate.ts` (npm run db:migrate)
runMigrationsCli();
