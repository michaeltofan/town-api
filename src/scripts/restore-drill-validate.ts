import { runRestoreDrillValidateCli } from '../platform/run-restore-drill-validate.js';

// Compiled production entrypoint: `node dist/scripts/restore-drill-validate.js`
// npm run restore-drill:validate:production
// (DATABASE_URL must point at the isolated restored instance, never Production)
runRestoreDrillValidateCli();
