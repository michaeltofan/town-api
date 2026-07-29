/**
 * Focused SetupGrant Authorization parser for password-setup routes.
 * Reuses the same header form as passkey registration; purpose is enforced downstream.
 */
export {
  parseSetupGrantAuthorization,
  type SetupGrantAuthorization,
} from '../passkey-registration/authorization.js';
