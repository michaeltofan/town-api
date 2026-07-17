import type { MembershipSource } from '../db/schema.js';
import { sourceNotAllowedError } from './errors.js';

/**
 * Rejects test_fixture when NODE_ENV is production.
 * stripe is reserved for future provider integration; production may accept stripe
 * source identity without calling the Stripe API.
 */
export function assertSourceAllowed(source: MembershipSource, nodeEnv: string): void {
  if (source === 'test_fixture' && nodeEnv === 'production') {
    throw sourceNotAllowedError();
  }
}
