import { hashPassword } from '../../identity/password-hashing.js';

/**
 * In-memory Argon2id PHC hash used only for timing equalization when no
 * account password credential is available. Never persisted to the database.
 * Uses the same production Argon2id parameters as real credentials via hashPassword.
 */
const DUMMY_PASSWORD_PLAINTEXT = 'town.password-sign-in.timing-dummy.v1';

let dummyHashPromise: Promise<string> | null = null;

export async function getPasswordSignInDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(DUMMY_PASSWORD_PLAINTEXT).then((result) => result.hash);
  return dummyHashPromise;
}

/** Test-only reset so suites can isolate dummy-hash lazy init if needed. */
export function resetPasswordSignInDummyHashForTests(): void {
  dummyHashPromise = null;
}
