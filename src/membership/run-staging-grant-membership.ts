import { randomUUID } from 'node:crypto';
import { createDatabase } from '../db/client.js';
import { findAccountById } from '../identity/repositories/accounts.js';
import { toIsoTimestamp } from '../lib/timestamps.js';
import { findEntitlementByAccountId } from './repositories/entitlements.js';
import { activateMembership } from './transitions/activate.js';

/**
 * Staging-only one-off runner: grant an existing account an active membership via
 * activateMembership(source='test_fixture'). Command/script only — no HTTP surface.
 *
 * Account identification: account id (UUID). activateMembership already keys on
 * accountId; email lookup would add unverified-email edge cases without benefit.
 *
 * Idempotency: if the account already has status=active with a future accessUntil,
 * no-op with outcome `already_active` (does not call the transition). Otherwise
 * calls activateMembership; a second run after grant hits the no-op path.
 */

const ACCOUNT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export type StagingGrantMembershipErrorCode =
  | 'NODE_ENV_PRODUCTION'
  | 'APP_ENV_NOT_STAGING'
  | 'DATABASE_URL_REQUIRED'
  | 'ACCOUNT_ID_REQUIRED'
  | 'ACCOUNT_ID_INVALID'
  | 'ACCOUNT_NOT_FOUND'
  | 'GRANT_FAILED';

export class StagingGrantMembershipError extends Error {
  readonly code: StagingGrantMembershipErrorCode;

  constructor(code: StagingGrantMembershipErrorCode, message: string) {
    super(message);
    this.name = 'StagingGrantMembershipError';
    this.code = code;
  }
}

export type StagingGrantMembershipOutcome = 'granted' | 'already_active';

export type StagingGrantMembershipResult = {
  readonly outcome: StagingGrantMembershipOutcome;
  readonly accountId: string;
  readonly membershipStatus: string;
  readonly accessUntil: string | null;
  readonly transitionResult?: string;
};

export type RunStagingGrantMembershipOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly accountId: string;
  readonly now?: () => Date;
  readonly generateId?: () => string;
};

function requireSafeEnv(env: NodeJS.ProcessEnv): string {
  // Hard refuse: never run under NODE_ENV=production (assertSourceAllowed also
  // blocks test_fixture there — keep that guard intact; do not override nodeEnv).
  if (env.NODE_ENV === 'production') {
    throw new StagingGrantMembershipError(
      'NODE_ENV_PRODUCTION',
      'Staging membership grant refuses NODE_ENV=production (fail closed)',
    );
  }

  // Project staging-only check (same class of gate as db:seed:staging / inspect).
  if (env.APP_ENV !== 'staging') {
    throw new StagingGrantMembershipError(
      'APP_ENV_NOT_STAGING',
      'Staging membership grant requires APP_ENV=staging and refuses all other environments',
    );
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new StagingGrantMembershipError(
      'DATABASE_URL_REQUIRED',
      'DATABASE_URL is required for membership:grant:staging:production',
    );
  }
  return databaseUrl;
}

function requireAccountId(raw: string): string {
  const accountId = raw.trim();
  if (accountId.length === 0) {
    throw new StagingGrantMembershipError(
      'ACCOUNT_ID_REQUIRED',
      'Account id is required (--account-id <uuid>)',
    );
  }
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new StagingGrantMembershipError('ACCOUNT_ID_INVALID', 'Account id must be a UUID');
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
        throw new StagingGrantMembershipError(
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
  throw new StagingGrantMembershipError(
    'ACCOUNT_ID_REQUIRED',
    'Account id is required (--account-id <uuid>)',
  );
}

export async function runStagingGrantMembership(
  options: RunStagingGrantMembershipOptions,
): Promise<StagingGrantMembershipResult> {
  const env = options.env ?? process.env;
  const databaseUrl = requireSafeEnv(env);
  const accountId = requireAccountId(options.accountId);
  const now = options.now ?? (() => new Date());
  const generateId = options.generateId ?? randomUUID;

  const database = createDatabase({
    connectionString: databaseUrl,
    poolMax: 2,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
  });

  try {
    const account = await findAccountById(database.db, accountId);
    if (!account) {
      throw new StagingGrantMembershipError(
        'ACCOUNT_NOT_FOUND',
        `Account was not found: ${accountId}`,
      );
    }

    const existing = await findEntitlementByAccountId(database.db, accountId);
    const nowDate = now();
    const nowIso = nowDate.toISOString();

    if (
      existing?.status === 'active' &&
      existing.accessUntil !== null &&
      new Date(existing.accessUntil).getTime() > nowDate.getTime()
    ) {
      return {
        outcome: 'already_active',
        accountId,
        membershipStatus: existing.status,
        accessUntil: toIsoTimestamp(existing.accessUntil),
      };
    }

    const accessUntil = new Date(nowDate.getTime() + ONE_YEAR_MS).toISOString();
    const sourceEventId = `staging_grant:${accountId}:${generateId()}`;

    const outcome = await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId,
        eventType: 'activate',
        accountId,
        effectiveAt: nowIso,
        accessUntil,
      },
      // Pass the same NODE_ENV requireSafeEnv already validated. Never rewrite a
      // production NODE_ENV to allow test_fixture — that gate fails closed above.
      {
        nodeEnv: env.NODE_ENV ?? 'development',
        processedAt: nowIso,
        generateId,
      },
    );

    if (outcome.result !== 'applied' && outcome.result !== 'replayed') {
      throw new StagingGrantMembershipError(
        'GRANT_FAILED',
        `activateMembership did not apply: result=${outcome.result} reason=${outcome.reason ?? 'none'}`,
      );
    }

    const entitlement = outcome.entitlement;
    if (!entitlement) {
      throw new StagingGrantMembershipError(
        'GRANT_FAILED',
        'activateMembership returned no entitlement',
      );
    }

    return {
      outcome: 'granted',
      accountId,
      membershipStatus: entitlement.status,
      accessUntil: entitlement.accessUntil ? toIsoTimestamp(entitlement.accessUntil) : null,
      transitionResult: outcome.result,
    };
  } finally {
    await database.close();
  }
}

function formatResult(result: StagingGrantMembershipResult): string {
  return [
    `outcome=${result.outcome}`,
    `accountId=${result.accountId}`,
    `membershipStatus=${result.membershipStatus}`,
    `accessUntil=${result.accessUntil ?? 'null'}`,
    result.transitionResult !== undefined ? `transitionResult=${result.transitionResult}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');
}

export function runStagingGrantMembershipCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): void {
  let accountId: string;
  try {
    accountId = parseAccountIdArg(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid arguments';
    const code =
      error instanceof StagingGrantMembershipError ? error.code : 'ACCOUNT_ID_REQUIRED';
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  runStagingGrantMembership({ env, accountId })
    .then((result) => {
      process.stdout.write(`${formatResult(result)}\n`);
      process.exitCode = 0;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Staging membership grant failed';
      const code = error instanceof StagingGrantMembershipError ? error.code : 'UNEXPECTED';
      process.stderr.write(`${code}: ${message}\n`);
      process.exitCode = 1;
    });
}
