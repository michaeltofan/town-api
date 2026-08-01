import { eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { accounts, type PlatformOperatorRole } from '../db/schema.js';
import { safeEqualString } from '../lib/safe-equal.js';
import { isPlatformOperatorRole } from './roles.js';
import { upsertPlatformOperator } from './repositories/operators.js';
import { appendPlatformAuditEvent } from './repositories/audit.js';
import { randomUUID } from 'node:crypto';

/**
 * One-off CLI: grant platform operator access to an account.
 *
 * Safety: requires PLATFORM_OPERATOR_SETUP_CODE to match
 * PLATFORM_OPERATOR_SETUP_CODE_EXPECTED via safeEqualString.
 * No HTTP surface. Separate from community owner (`account:mark-owner`).
 */

const ACCOUNT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PLATFORM_OPERATOR_SETUP_CODE_LENGTH = 128;

export type MarkPlatformOperatorErrorCode =
  | 'DATABASE_URL_REQUIRED'
  | 'PLATFORM_OPERATOR_SETUP_CODE_REQUIRED'
  | 'PLATFORM_OPERATOR_SETUP_CODE_EXPECTED_REQUIRED'
  | 'PLATFORM_OPERATOR_SETUP_CODE_INVALID_LENGTH'
  | 'PLATFORM_OPERATOR_SETUP_CODE_EXPECTED_INVALID_LENGTH'
  | 'PLATFORM_OPERATOR_SETUP_CODE_MISMATCH'
  | 'ACCOUNT_ID_REQUIRED'
  | 'ACCOUNT_ID_INVALID'
  | 'ROLE_INVALID'
  | 'ACCOUNT_NOT_FOUND';

export class MarkPlatformOperatorError extends Error {
  readonly code: MarkPlatformOperatorErrorCode;

  constructor(code: MarkPlatformOperatorErrorCode, message: string) {
    super(message);
    this.name = 'MarkPlatformOperatorError';
    this.code = code;
  }
}

export type MarkPlatformOperatorResult = {
  readonly outcome: 'granted' | 'already_active' | 'role_changed';
  readonly accountId: string;
  readonly role: PlatformOperatorRole;
};

export type RunMarkPlatformOperatorOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly accountId: string;
  readonly role: PlatformOperatorRole;
  readonly now?: () => Date;
};

function requireDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new MarkPlatformOperatorError(
      'DATABASE_URL_REQUIRED',
      'DATABASE_URL is required for account:mark-platform-operator:production',
    );
  }
  return databaseUrl;
}

function requireSetupCodes(env: NodeJS.ProcessEnv): void {
  const supplied = env.PLATFORM_OPERATOR_SETUP_CODE;
  const expected = env.PLATFORM_OPERATOR_SETUP_CODE_EXPECTED;

  if (typeof supplied !== 'string' || supplied.length === 0) {
    throw new MarkPlatformOperatorError(
      'PLATFORM_OPERATOR_SETUP_CODE_REQUIRED',
      'PLATFORM_OPERATOR_SETUP_CODE is required (128-character setup code)',
    );
  }
  if (typeof expected !== 'string' || expected.length === 0) {
    throw new MarkPlatformOperatorError(
      'PLATFORM_OPERATOR_SETUP_CODE_EXPECTED_REQUIRED',
      'PLATFORM_OPERATOR_SETUP_CODE_EXPECTED is required (128-character expected setup code)',
    );
  }
  if (supplied.length !== PLATFORM_OPERATOR_SETUP_CODE_LENGTH) {
    throw new MarkPlatformOperatorError(
      'PLATFORM_OPERATOR_SETUP_CODE_INVALID_LENGTH',
      `PLATFORM_OPERATOR_SETUP_CODE must be exactly ${String(PLATFORM_OPERATOR_SETUP_CODE_LENGTH)} characters`,
    );
  }
  if (expected.length !== PLATFORM_OPERATOR_SETUP_CODE_LENGTH) {
    throw new MarkPlatformOperatorError(
      'PLATFORM_OPERATOR_SETUP_CODE_EXPECTED_INVALID_LENGTH',
      `PLATFORM_OPERATOR_SETUP_CODE_EXPECTED must be exactly ${String(PLATFORM_OPERATOR_SETUP_CODE_LENGTH)} characters`,
    );
  }
  if (!safeEqualString(supplied, expected)) {
    throw new MarkPlatformOperatorError(
      'PLATFORM_OPERATOR_SETUP_CODE_MISMATCH',
      'PLATFORM_OPERATOR_SETUP_CODE does not match PLATFORM_OPERATOR_SETUP_CODE_EXPECTED (refusing; no changes made)',
    );
  }
}

function requireAccountId(raw: string): string {
  const accountId = raw.trim();
  if (accountId.length === 0) {
    throw new MarkPlatformOperatorError(
      'ACCOUNT_ID_REQUIRED',
      'Account id is required (--account-id <uuid>)',
    );
  }
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new MarkPlatformOperatorError('ACCOUNT_ID_INVALID', 'Account id must be a UUID');
  }
  return accountId;
}

export function parseMarkPlatformOperatorArgs(argv: readonly string[]): {
  accountId: string;
  role: PlatformOperatorRole;
} {
  let accountId: string | undefined;
  let role: PlatformOperatorRole = 'ops_admin';

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== 'string') {
      continue;
    }
    if (token === '--account-id' || token === '--accountId') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.startsWith('--')) {
        throw new MarkPlatformOperatorError(
          'ACCOUNT_ID_REQUIRED',
          'Account id is required (--account-id <uuid>)',
        );
      }
      accountId = requireAccountId(value);
      continue;
    }
    if (token.startsWith('--account-id=') || token.startsWith('--accountId=')) {
      accountId = requireAccountId(token.slice(token.indexOf('=') + 1));
      continue;
    }
    if (token === '--role') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || !isPlatformOperatorRole(value)) {
        throw new MarkPlatformOperatorError(
          'ROLE_INVALID',
          'Role must be one of: viewer, investigator, moderator, account_admin, ops_admin, role_admin',
        );
      }
      role = value;
      continue;
    }
    if (token.startsWith('--role=')) {
      const value = token.slice('--role='.length);
      if (!isPlatformOperatorRole(value)) {
        throw new MarkPlatformOperatorError(
          'ROLE_INVALID',
          'Role must be one of: viewer, investigator, moderator, account_admin, ops_admin, role_admin',
        );
      }
      role = value;
    }
  }

  if (!accountId) {
    throw new MarkPlatformOperatorError(
      'ACCOUNT_ID_REQUIRED',
      'Account id is required (--account-id <uuid>)',
    );
  }

  return { accountId, role };
}

export async function runMarkPlatformOperator(
  options: RunMarkPlatformOperatorOptions,
): Promise<MarkPlatformOperatorResult> {
  const env = options.env ?? process.env;
  requireSetupCodes(env);
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
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (!existing[0]) {
      throw new MarkPlatformOperatorError(
        'ACCOUNT_NOT_FOUND',
        `Account was not found: ${accountId}`,
      );
    }

    const at = now().toISOString();
    const result = await upsertPlatformOperator(database.db, {
      accountId,
      role: options.role,
      grantedByAccountId: null,
      at,
    });

    if (result.outcome !== 'already_active') {
      await appendPlatformAuditEvent(database.db, {
        id: randomUUID(),
        operatorAccountId: accountId,
        action: result.outcome === 'role_changed' ? 'operator_role_changed' : 'operator_granted',
        occurredAt: at,
        targetAccountId: accountId,
        metadata: { role: options.role, source: 'cli' },
      });
    }

    return {
      outcome: result.outcome,
      accountId: result.row.accountId,
      role: result.row.role as PlatformOperatorRole,
    };
  } finally {
    await database.close();
  }
}

function formatResult(result: MarkPlatformOperatorResult): string {
  return [`outcome=${result.outcome}`, `accountId=${result.accountId}`, `role=${result.role}`].join(
    ' ',
  );
}

export function runMarkPlatformOperatorCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): void {
  let parsed: { accountId: string; role: PlatformOperatorRole };
  try {
    parsed = parseMarkPlatformOperatorArgs(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid arguments';
    const code = error instanceof MarkPlatformOperatorError ? error.code : 'ACCOUNT_ID_REQUIRED';
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  runMarkPlatformOperator({ env, accountId: parsed.accountId, role: parsed.role })
    .then((result) => {
      process.stdout.write(`${formatResult(result)}\n`);
      process.exitCode = 0;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Mark platform operator failed';
      const code = error instanceof MarkPlatformOperatorError ? error.code : 'UNEXPECTED';
      process.stderr.write(`${code}: ${message}\n`);
      process.exitCode = 1;
    });
}
