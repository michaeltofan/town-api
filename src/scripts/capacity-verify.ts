import { runCapacityVerifyCli } from '../platform/run-capacity-verify.js';

// Compiled production entrypoint: `node dist/scripts/capacity-verify.js`
// Runs only inside a throwaway Railway service whose DATABASE_URL points at
// the same isolated, temporary Postgres capacity-setup.js provisioned.
runCapacityVerifyCli();
