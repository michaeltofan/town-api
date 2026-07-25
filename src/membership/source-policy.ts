import type { MembershipSource } from '../db/schema.js';
import { sourceNotAllowedError } from './errors.js';

/**
 * Rejects test_fixture when NODE_ENV is production.
 * stripe and google_play are live provider source identities; production may accept them
 * without implying that a provider network call occurred in this process.
 */
export function assertSourceAllowed(source: MembershipSource, nodeEnv: string): void {
  if (source === 'test_fixture' && nodeEnv === 'production') {
    throw sourceNotAllowedError();
  }
}
