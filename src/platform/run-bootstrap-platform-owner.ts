import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { accounts, actors, type PlatformOperatorRole } from '../db/schema.js';
import { FOUNDATION_COMMUNITIES } from '../db/seeds/foundation-content.js';
import { normalizeEmail } from '../identity/email-normalize.js';
import { hashPassword } from '../identity/password-hashing.js';
import {
  normalizeAndValidateInitialPassword,
  PasswordPolicyError,
} from '../identity/password-policy.js';
import {
  createAccountShell,
  ensureWebAuthnUserHandle,
  findAccountById,
  transitionAccountState,
} from '../identity/repositories/accounts.js';
import { createCivicActor, linkActorToAccount } from '../identity/repositories/actor-link.js';
import {
  addAccountEmail,
  findActiveEmailByNormalized,
  verifyEmail,
} from '../identity/repositories/emails.js';
import {
  createAccountPasswordCredential,
  findActiveAccountPasswordCredential,
  revokeAccountPasswordCredential,
} from '../identity/repositories/password-credentials.js';
import { appendPlatformAuditEvent } from './repositories/audit.js';
import { upsertPlatformOperator } from './repositories/operators.js';
import { isPlatformOperatorRole } from './roles.js';

/**
 * Staging/ops bootstrap: create (or upgrade) an active email+password account,
 * mark is_owner, and grant platform operator role_admin by default.
 *
 * Intended for MacBook via `railway run` against private DATABASE_URL.
 * Refuses non-staging APP_ENV unless BOOTSTRAP_ALLOW_NON_STAGING=yes.
 */

export type BootstrapPlatformOwnerErrorCode =
  | 'DATABASE_URL_REQUIRED'
  | 'APP_ENV_NOT_STAGING'
  | 'EMAIL_REQUIRED'
  | 'EMAIL_INVALID'
  | 'PASSWORD_REQUIRED'
  | 'PASSWORD_POLICY_VIOLATION'
  | 'ROLE_INVALID'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_STATUS_UNSUPPORTED';

export class BootstrapPlatformOwnerError extends Error {
  readonly code: BootstrapPlatformOwnerErrorCode;

  constructor(code: BootstrapPlatformOwnerErrorCode, message: string) {
    super(message);
    this.name = 'BootstrapPlatformOwnerError';
    this.code = code;
  }
}

export type BootstrapPlatformOwnerResult = {
  readonly accountId: string;
  readonly email: string;
  readonly created: boolean;
  readonly passwordSet: boolean;
  readonly isOwner: boolean;
  readonly operatorRole: PlatformOperatorRole;
  readonly operatorOutcome: 'granted' | 'already_active' | 'role_changed';
};

export type RunBootstrapPlatformOwnerOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly email: string;
  readonly password: string;
  readonly role?: PlatformOperatorRole;
  readonly markOwner?: boolean;
  readonly now?: () => Date;
};

function requireDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new BootstrapPlatformOwnerError(
      'DATABASE_URL_REQUIRED',
      'DATABASE_URL is required (use railway run so private Postgres is injected)',
    );
  }
  return databaseUrl;
}

function assertStagingAllowed(env: NodeJS.ProcessEnv): void {
  const appEnv = (env.APP_ENV ?? '').trim().toLowerCase();
  if (appEnv === 'staging') return;
  if ((env.BOOTSTRAP_ALLOW_NON_STAGING ?? '').trim().toLowerCase() === 'yes') return;
  throw new BootstrapPlatformOwnerError(
    'APP_ENV_NOT_STAGING',
    'Refusing bootstrap unless APP_ENV=staging (or BOOTSTRAP_ALLOW_NON_STAGING=yes)',
  );
}

function requireEmail(raw: string): string {
  const email = raw.trim();
  if (!email) {
    throw new BootstrapPlatformOwnerError('EMAIL_REQUIRED', 'Email is required (--email)');
  }
  if (!email.includes('@') || email.length > 320) {
    throw new BootstrapPlatformOwnerError('EMAIL_INVALID', 'Email looks invalid');
  }
  return email;
}

function requirePassword(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new BootstrapPlatformOwnerError('PASSWORD_REQUIRED', 'Password is required (--password)');
  }
  try {
    return normalizeAndValidateInitialPassword(raw);
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      throw new BootstrapPlatformOwnerError(
        'PASSWORD_POLICY_VIOLATION',
        'Password does not meet policy (15–128 Unicode code points)',
      );
    }
    throw error;
  }
}

export function parseBootstrapPlatformOwnerArgs(argv: readonly string[]): {
  email: string;
  password: string;
  role: PlatformOperatorRole;
  markOwner: boolean;
} {
  let email: string | undefined;
  let password: string | undefined;
  let role: PlatformOperatorRole = 'role_admin';
  let markOwner = true;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== 'string') continue;

    if (token === '--email') {
      email = requireEmail(argv[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (token.startsWith('--email=')) {
      email = requireEmail(token.slice('--email='.length));
      continue;
    }
    if (token === '--password') {
      password = requirePassword(argv[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (token.startsWith('--password=')) {
      password = requirePassword(token.slice('--password='.length));
      continue;
    }
    if (token === '--role') {
      const value = argv[i + 1] ?? '';
      if (!isPlatformOperatorRole(value)) {
        throw new BootstrapPlatformOwnerError(
          'ROLE_INVALID',
          'Role must be one of: viewer, investigator, moderator, account_admin, ops_admin, role_admin',
        );
      }
      role = value;
      i += 1;
      continue;
    }
    if (token.startsWith('--role=')) {
      const value = token.slice('--role='.length);
      if (!isPlatformOperatorRole(value)) {
        throw new BootstrapPlatformOwnerError(
          'ROLE_INVALID',
          'Role must be one of: viewer, investigator, moderator, account_admin, ops_admin, role_admin',
        );
      }
      role = value;
      continue;
    }
    if (token === '--no-mark-owner') {
      markOwner = false;
    }
  }

  if (!email) {
    throw new BootstrapPlatformOwnerError('EMAIL_REQUIRED', 'Email is required (--email)');
  }
  if (!password) {
    throw new BootstrapPlatformOwnerError('PASSWORD_REQUIRED', 'Password is required (--password)');
  }

  return { email, password, role, markOwner };
}

async function ensurePasswordCredential(
  db: ReturnType<typeof createDatabase>['db'],
  accountId: string,
  password: string,
  at: string,
): Promise<void> {
  const existing = await findActiveAccountPasswordCredential(db, accountId);
  if (existing) {
    await revokeAccountPasswordCredential(db, { accountId, revokedAt: at });
  }
  const hashed = await hashPassword(password);
  await createAccountPasswordCredential(db, {
    id: randomUUID(),
    accountId,
    passwordHash: hashed.hash,
    algorithm: hashed.algorithm,
    parameters: hashed.parameters,
    createdAt: at,
  });
}

async function ensureLinkedCivicActor(
  db: ReturnType<typeof createDatabase>['db'],
  accountId: string,
  at: string,
): Promise<void> {
  const existingActor = await db
    .select({ id: actors.id })
    .from(actors)
    .where(eq(actors.accountId, accountId))
    .limit(1);
  if (existingActor[0]) return;

  const actorId = randomUUID();
  const communityId = FOUNDATION_COMMUNITIES[0].id;
  await createCivicActor(db, {
    id: actorId,
    displayLabel: 'TOWN Platform Owner',
    communityId,
    createdAt: at,
    updatedAt: at,
  });
  await linkActorToAccount(db, {
    actorId,
    accountId,
    at,
  });
}

export async function runBootstrapPlatformOwner(
  options: RunBootstrapPlatformOwnerOptions,
): Promise<BootstrapPlatformOwnerResult> {
  const env = options.env ?? process.env;
  assertStagingAllowed(env);
  const databaseUrl = requireDatabaseUrl(env);
  const emailOriginal = requireEmail(options.email);
  const password = requirePassword(options.password);
  const role = options.role ?? 'role_admin';
  if (!isPlatformOperatorRole(role)) {
    throw new BootstrapPlatformOwnerError('ROLE_INVALID', 'Invalid operator role');
  }
  const markOwner = options.markOwner !== false;
  const now = options.now ?? (() => new Date());
  const at = now().toISOString();
  const emailNormalized = normalizeEmail(emailOriginal);

  const database = createDatabase({
    connectionString: databaseUrl,
    poolMax: 2,
    connectionTimeoutMs: 8_000,
    idleTimeoutMs: 1_000,
  });

  try {
    const existingEmail = await findActiveEmailByNormalized(database.db, emailNormalized);
    let accountId: string;
    let created = false;

    if (existingEmail) {
      accountId = existingEmail.accountId;
      const account = await findAccountById(database.db, accountId);
      if (!account) {
        throw new BootstrapPlatformOwnerError(
          'ACCOUNT_NOT_FOUND',
          `Account missing for email ${emailNormalized}`,
        );
      }

      if (account.status === 'suspended' || account.status === 'closed') {
        throw new BootstrapPlatformOwnerError(
          'ACCOUNT_STATUS_UNSUPPORTED',
          `Account status ${account.status} cannot be bootstrapped`,
        );
      }

      if (!existingEmail.verifiedAt) {
        await verifyEmail(database.db, { emailId: existingEmail.id, verifiedAt: at });
      }

      if (account.status === 'pending_email') {
        await transitionAccountState(database.db, {
          accountId,
          to: 'pending_password',
          at,
        });
      }

      const afterEmail = await findAccountById(database.db, accountId);
      if (afterEmail?.status === 'pending_password') {
        await ensurePasswordCredential(database.db, accountId, password, at);
        await transitionAccountState(database.db, {
          accountId,
          to: 'pending_passkey',
          at,
        });
      } else if (afterEmail?.status === 'pending_passkey' || afterEmail?.status === 'active') {
        await ensurePasswordCredential(database.db, accountId, password, at);
      }
    } else {
      accountId = randomUUID();
      created = true;
      await createAccountShell(database.db, {
        id: accountId,
        createdAt: at,
        updatedAt: at,
      });
      const emailId = randomUUID();
      await addAccountEmail(database.db, {
        id: emailId,
        accountId,
        email: emailOriginal,
        isPrimary: true,
        createdAt: at,
        updatedAt: at,
      });
      await verifyEmail(database.db, { emailId, verifiedAt: at });
      await transitionAccountState(database.db, {
        accountId,
        to: 'pending_password',
        at,
      });
      await ensurePasswordCredential(database.db, accountId, password, at);
      await transitionAccountState(database.db, {
        accountId,
        to: 'pending_passkey',
        at,
      });
    }

    await ensureWebAuthnUserHandle(database.db, {
      accountId,
      handle: randomBytes(32),
      now: at,
    });
    await ensureLinkedCivicActor(database.db, accountId, at);

    const beforeActive = await findAccountById(database.db, accountId);
    if (beforeActive?.status === 'pending_passkey') {
      await transitionAccountState(database.db, {
        accountId,
        to: 'active',
        at,
      });
    }

    if (markOwner) {
      await database.db
        .update(accounts)
        .set({ isOwner: true, updatedAt: at })
        .where(eq(accounts.id, accountId));
    }

    const operator = await upsertPlatformOperator(database.db, {
      accountId,
      role,
      grantedByAccountId: null,
      at,
    });

    if (operator.outcome !== 'already_active') {
      await appendPlatformAuditEvent(database.db, {
        id: randomUUID(),
        operatorAccountId: accountId,
        action: operator.outcome === 'role_changed' ? 'operator_role_changed' : 'operator_granted',
        occurredAt: at,
        targetAccountId: accountId,
        metadata: {
          role,
          source: 'bootstrap_platform_owner_cli',
          emailNormalized,
        },
      });
    }

    const finalAccount = await findAccountById(database.db, accountId);

    return {
      accountId,
      email: emailNormalized,
      created,
      passwordSet: true,
      isOwner: finalAccount?.isOwner === true,
      operatorRole: role,
      operatorOutcome: operator.outcome,
    };
  } finally {
    await database.close();
  }
}

export function runBootstrapPlatformOwnerCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): void {
  let args: {
    email: string;
    password: string;
    role: PlatformOperatorRole;
    markOwner: boolean;
  };
  try {
    args = parseBootstrapPlatformOwnerArgs(argv);
  } catch (error: unknown) {
    const code = error instanceof BootstrapPlatformOwnerError ? error.code : 'BOOTSTRAP_FAILED';
    const message = error instanceof Error ? error.message : 'Invalid arguments';
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  runBootstrapPlatformOwner({
    env,
    email: args.email,
    password: args.password,
    role: args.role,
    markOwner: args.markOwner,
  })
    .then((result) => {
      process.stdout.write(
        [
          'BOOTSTRAP_OK',
          `accountId=${result.accountId}`,
          `email=${result.email}`,
          `created=${String(result.created)}`,
          `passwordSet=${String(result.passwordSet)}`,
          `isOwner=${String(result.isOwner)}`,
          `operatorRole=${result.operatorRole}`,
          `operatorOutcome=${result.operatorOutcome}`,
          '',
        ].join('\n'),
      );
      process.exitCode = 0;
    })
    .catch((error: unknown) => {
      const code = error instanceof BootstrapPlatformOwnerError ? error.code : 'BOOTSTRAP_FAILED';
      const message = error instanceof Error ? error.message : 'Bootstrap failed';
      process.stderr.write(`${code}: ${message}\n`);
      process.exitCode = 1;
    });
}
