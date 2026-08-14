import { runCapacitySetupCli } from '../platform/run-capacity-setup.js';

// Compiled production entrypoint: `node dist/scripts/capacity-setup.js`
// Runs only inside a throwaway Railway service whose DATABASE_URL points at
// a brand-new, isolated, temporary Postgres (see
// docs/operations/CAPACITY_DRILL_RUNBOOK.md). Never staging, never production.
runCapacitySetupCli();
