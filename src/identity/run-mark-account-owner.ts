import { eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { accounts } from '../db/schema.js';
import { safeEqualString } from '../lib/safe-equal.js';

/**
 * One-off CLI: mark a single account as owner (is_owner=true).
 *
 * Safety: requires OWNER_SETUP_CODE to match OWNER_SETUP_CODE_EXPECTED via
 * safeEqualString (constant-time hashed compare). No HTTP surface. Does not
 * grant membership, sessions, civic access, or change authorization behavior —
 * is_owner is an inert label until a later slice deliberately uses it.
 *
 * Allowed in staging and production (no NODE_ENV/APP_ENV gate).
 */

const ACCOUNT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const OWNER_SETUP_CODE_LENGTH = 128;

export type MarkAccountOwnerErrorCode =
  | 'DATABASE_URL_REQUIRED'
  | 'OWNER_SETUP_CODE_REQUIRED'
  | 'OWNER_SETUP_CODE_EXPECTED_REQUIRED'
  | 'OWNER_SETUP_CODE_INVALID_LENGTH'
  | 'OWNER_SETUP_CODE_EXPECTED_INVALID_LENGTH'
  | 'OWNER_SETUP_CODE_MISMATCH'
  | 'ACCOUNT_ID_REQUIRED'
  | 'ACCOUNT_ID_INVALID'
  | 'ACCOUNT_NOT_FOUND';

export class MarkAccountOwnerError extends Error {
  readonly code: MarkAccountOwnerErrorCode;

  constructor(code: MarkAccountOwnerErrorCode, message: string) {
    super(message);
    this.name = 'MarkAccountOwnerError';
    this.code = code;
  }
}

export type MarkAccountOwnerOutcome = 'marked' | 'already_owner';

export type MarkAccountOwnerResult = {
  readonly outcome: MarkAccountOwnerOutcome;
  readonly accountId: string;
  readonly isOwner: boolean;
};

export type RunMarkAccountOwnerOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly accountId: string;
  readonly now?: () => Date;
};

function requireDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new MarkAccountOwnerError(
      'DATABASE_URL_REQUIRED',
      'DATABASE_URL is required for account:mark-owner:production',
    );
  }
  return databaseUrl;
}

function requireOwnerSetupCodes(env: NodeJS.ProcessEnv): void {
  const supplied = env.OWNER_SETUP_CODE;
  const expected = env.OWNER_SETUP_CODE_EXPECTED;

  if (typeof supplied !== 'string' || supplied.length === 0) {
    throw new MarkAccountOwnerError(
      'OWNER_SETUP_CODE_REQUIRED',
      'OWNER_SETUP_CODE is required (128-character owner setup code)',
    );
  }
  if (typeof expected !== 'string' || expected.length === 0) {
    throw new MarkAccountOwnerError(
      'OWNER_SETUP_CODE_EXPECTED_REQUIRED',
      'OWNER_SETUP_CODE_EXPECTED is required (128-character expected owner setup code)',
    );
  }
  if (supplied.length !== OWNER_SETUP_CODE_LENGTH) {
    throw new MarkAccountOwnerError(
      'OWNER_SETUP_CODE_INVALID_LENGTH',
      `OWNER_SETUP_CODE must be exactly ${String(OWNER_SETUP_CODE_LENGTH)} characters`,
    );
  }
  if (expected.length !== OWNER_SETUP_CODE_LENGTH) {
    throw new MarkAccountOwnerError(
      'OWNER_SETUP_CODE_EXPECTED_INVALID_LENGTH',
      `OWNER_SETUP_CODE_EXPECTED must be exactly ${String(OWNER_SETUP_CODE_LENGTH)} characters`,
    );
  }
  if (!safeEqualString(supplied, expected)) {
    throw new MarkAccountOwnerError(
      'OWNER_SETUP_CODE_MISMATCH',
      'OWNER_SETUP_CODE does not match OWNER_SETUP_CODE_EXPECTED (refusing; no changes made)',
    );
  }
}

function requireAccountId(raw: string): string {
  const accountId = raw.trim();
  if (accountId.length === 0) {
    throw new MarkAccountOwnerError(
      'ACCOUNT_ID_REQUIRED',
      'Account id is required (--account-id <uuid>)',
    );
  }
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new MarkAccountOwnerError('ACCOUNT_ID_INVALID', 'Account id must be a UUID');
  }
  return accountId;
}

export function parseAccountIdArg(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== 'string') {
      continue;
    }
    if (token === '--account-id' || token === '--accountId') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.startsWith('--')) {
        throw new MarkAccountOwnerError(
          'ACCOUNT_ID_REQUIRED',
          'Account id is required (--account-id <uuid>)',
        );
      }
      return requireAccountId(value);
    }
    if (token.startsWith('--account-id=') || token.startsWith('--accountId=')) {
      return requireAccountId(token.slice(token.indexOf('=') + 1));
    }
  }
  throw new MarkAccountOwnerError(
    'ACCOUNT_ID_REQUIRED',
    'Account id is required (--account-id <uuid>)',
  );
}

export async function runMarkAccountOwner(
  options: RunMarkAccountOwnerOptions,
): Promise<MarkAccountOwnerResult> {
  const env = options.env ?? process.env;
  requireOwnerSetupCodes(env);
  const databaseUrl = requireDatabaseUrl(env);
  const accountId = requireAccountId(options.accountId);
  const now = options.now ?? (() => new Date());

  const database = createDatabase({
    connectionString: databaseUrl,
    poolMax: 2,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
  });

  try {
    const existing = await database.db
      .select({
        id: accounts.id,
        isOwner: accounts.isOwner,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    const row = existing[0];
    if (!row) {
      throw new MarkAccountOwnerError('ACCOUNT_NOT_FOUND', `Account was not found: ${accountId}`);
    }

    if (row.isOwner) {
      return {
        outcome: 'already_owner',
        accountId,
        isOwner: true,
      };
    }

    const updated = await database.db
      .update(accounts)
      .set({
        isOwner: true,
        updatedAt: now().toISOString(),
      })
      .where(eq(accounts.id, accountId))
      .returning({
        id: accounts.id,
        isOwner: accounts.isOwner,
      });

    const marked = updated[0];
    if (!marked) {
      throw new MarkAccountOwnerError('ACCOUNT_NOT_FOUND', `Account was not found: ${accountId}`);
    }

    return {
      outcome: 'marked',
      accountId: marked.id,
      isOwner: marked.isOwner,
    };
  } finally {
    await database.close();
  }
}

function formatResult(result: MarkAccountOwnerResult): string {
  return [
    `outcome=${result.outcome}`,
    `accountId=${result.accountId}`,
    `isOwner=${String(result.isOwner)}`,
  ].join(' ');
}

export function runMarkAccountOwnerCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): void {
  let accountId: string;
  try {
    accountId = parseAccountIdArg(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid arguments';
    const code = error instanceof MarkAccountOwnerError ? error.code : 'ACCOUNT_ID_REQUIRED';
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  runMarkAccountOwner({ env, accountId })
    .then((result) => {
      process.stdout.write(`${formatResult(result)}\n`);
      process.exitCode = 0;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Mark account owner failed';
      const code = error instanceof MarkAccountOwnerError ? error.code : 'UNEXPECTED';
      process.stderr.write(`${code}: ${message}\n`);
      process.exitCode = 1;
    });
}
