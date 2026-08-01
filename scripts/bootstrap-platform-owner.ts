import { runBootstrapPlatformOwnerCli } from '../src/platform/run-bootstrap-platform-owner.js';

// Local / CI entrypoint (MacBook + railway run):
// railway run npm run account:bootstrap-platform-owner -- \
//   --email voceacivica@proton.me \
//   --password '<64-char-password>' \
//   --role role_admin
runBootstrapPlatformOwnerCli();
