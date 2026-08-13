import { runRestoreDrillValidateCli } from '../src/platform/run-restore-drill-validate.js';

// Local / CI entrypoint: `tsx scripts/restore-drill-validate.ts`
// (DATABASE_URL must point at the isolated restored instance, never Production)
runRestoreDrillValidateCli();
