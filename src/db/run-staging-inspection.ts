import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

/**
 * Read-only staging inspection runner.
 * APP_ENV=staging only. Single client. READ ONLY transaction + statement_timeout.
 * Does NOT check the migration ledger — GET /health/ready remains authoritative.
 */

export type StagingInspectionErrorCode =
  'APP_ENV_NOT_STAGING' | 'DATABASE_URL_REQUIRED' | 'SCHEMA_MISMATCH' | 'INSPECTION_FAILED';

export class StagingInspectionError extends Error {
  readonly code: StagingInspectionErrorCode;

  constructor(code: StagingInspectionErrorCode, message: string) {
    super(message);
    this.name = 'StagingInspectionError';
    this.code = code;
  }
}

export type StagingInspectionRowCounts = {
  readonly account_emails: number;
  readonly account_sessions: number;
  readonly accounts: number;
  readonly actors: number;
  readonly ceremony_rate_limits: number;
  readonly communities: number;
  readonly email_challenges: number;
  readonly identity_security_events: number;
  readonly membership_entitlements: number;
  readonly membership_source_events: number;
  readonly passkey_credentials: number;
  readonly recovery_grants: number;
  readonly setup_grants: number;
  readonly signal_confirmations: number;
  readonly signal_submissions: number;
  readonly signals: number;
  readonly stripe_checkout_attempts: number;
  readonly stripe_customer_links: number;
  readonly webauthn_challenges: number;
};

export type StagingInspectionResult = {
  readonly migrationLedgerChecked: false;
  readonly migrationLedgerAuthority: 'GET /health/ready';
  readonly schemaCheck: {
    readonly table: 'town.signal_submissions';
    readonly status: 'ok';
  };
  readonly rowCounts: StagingInspectionRowCounts;
  readonly eligibilityFinding: {
    readonly actorsBoundMissingLocalEligibilityVerifiedAt: number;
  };
};

type ExpectedColumn = {
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: 'YES' | 'NO';
};

/** Hardcoded expected shape for town.signal_submissions (moderation-ready). */
export const EXPECTED_SIGNAL_SUBMISSIONS_COLUMNS: readonly ExpectedColumn[] = [
  { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
  { column_name: 'account_id', data_type: 'uuid', is_nullable: 'NO' },
  { column_name: 'actor_id', data_type: 'uuid', is_nullable: 'NO' },
  { column_name: 'community_id', data_type: 'uuid', is_nullable: 'NO' },
  { column_name: 'headline', data_type: 'text', is_nullable: 'NO' },
  { column_name: 'body', data_type: 'text', is_nullable: 'NO' },
  { column_name: 'status', data_type: 'text', is_nullable: 'NO' },
  { column_name: 'reviewed_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
  { column_name: 'reviewed_by_account_id', data_type: 'uuid', is_nullable: 'YES' },
  { column_name: 'review_reason', data_type: 'text', is_nullable: 'YES' },
  { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
  { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
];

export type RunStagingInspectionOptions = {
  readonly env?: NodeJS.ProcessEnv;
  /** Test-only: run after BEGIN + SET LOCAL, before checks (same client). */
  readonly afterTransactionReady?: (client: PoolClient) => Promise<void>;
  /** Test-only: throw during checks (after transaction started). */
  readonly injectCheckFailure?: Error;
  /** Test-only: fail pool.connect(). */
  readonly injectConnectFailure?: Error;
  /** Test-only: fail BEGIN TRANSACTION READ ONLY. */
  readonly injectBeginFailure?: Error;
  /** Test-only: fail SET LOCAL statement_timeout. */
  readonly injectSetLocalFailure?: Error;
  /** Test-only: fail COMMIT. */
  readonly injectCommitFailure?: Error;
  /** Test-only: fail ROLLBACK. */
  readonly injectRollbackFailure?: Error;
  /** Test-only: fail client.release(). */
  readonly injectReleaseFailure?: Error;
  /** Test-only: fail pool.end(). */
  readonly injectPoolEndFailure?: Error;
  /** Test-only: replace Pool construction (spies / fakes). */
  readonly createPool?: (config: {
    connectionString: string;
    max: number;
    connectionTimeoutMillis: number;
  }) => Pool;
};

type LogStage =
  | 'env_check'
  | 'connect'
  | 'begin'
  | 'set_timeout'
  | 'check_schema'
  | 'check_counts'
  | 'check_eligibility'
  | 'commit'
  | 'rollback'
  | 'release'
  | 'pool_end'
  | 'complete'
  | 'error';

function logEvent(
  stage: LogStage,
  status: 'ok' | 'fail' | 'skip',
  details: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const payload: Record<string, string | number | boolean | null> = {
    operation: 'db:inspect:staging:production',
    stage,
    status,
  };
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined) {
      payload[key] = value;
    }
  }
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

function requireStagingEnv(env: NodeJS.ProcessEnv): string {
  const appEnv = env.APP_ENV;
  if (appEnv !== 'staging') {
    throw new StagingInspectionError(
      'APP_ENV_NOT_STAGING',
      'Staging inspection runner requires APP_ENV=staging and refuses all other environments',
    );
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new StagingInspectionError(
      'DATABASE_URL_REQUIRED',
      'DATABASE_URL is required for db:inspect:staging:production',
    );
  }
  return databaseUrl;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Staging inspection failed';
}

async function queryClient<R extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  values?: unknown[],
): Promise<QueryResult<R>> {
  if (values === undefined) {
    return client.query<R>(text);
  }
  return client.query<R>(text, values);
}

async function assertSignalSubmissionsSchema(client: PoolClient): Promise<void> {
  const columns = await queryClient<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    client,
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'town'
       AND table_name = 'signal_submissions'
     ORDER BY ordinal_position`,
  );

  const actualColumns = columns.rows.map((row) => ({
    column_name: row.column_name,
    data_type: row.data_type,
    is_nullable: row.is_nullable,
  }));
  const expectedColumns = EXPECTED_SIGNAL_SUBMISSIONS_COLUMNS.map((row) => ({
    column_name: row.column_name,
    data_type: row.data_type,
    is_nullable: row.is_nullable,
  }));

  if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
    throw new StagingInspectionError(
      'SCHEMA_MISMATCH',
      'town.signal_submissions columns do not match the expected hardcoded schema',
    );
  }

  const primaryKey = await queryClient<{ column_name: string }>(
    client,
    `SELECT a.attname AS column_name
     FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = rel.oid AND a.attnum = cols.attnum
     WHERE nsp.nspname = 'town'
       AND rel.relname = 'signal_submissions'
       AND con.contype = 'p'
     ORDER BY cols.ord`,
  );
  if (primaryKey.rows.length !== 1 || primaryKey.rows[0]?.column_name !== 'id') {
    throw new StagingInspectionError(
      'SCHEMA_MISMATCH',
      'town.signal_submissions primary key must be exactly on id',
    );
  }

  const foreignKeys = await queryClient<{
    conname: string;
    column_name: string;
    foreign_table_schema: string;
    foreign_table_name: string;
    foreign_column_name: string;
    confdeltype: string;
  }>(
    client,
    `SELECT
       con.conname,
       att.attname AS column_name,
       fnsp.nspname AS foreign_table_schema,
       frel.relname AS foreign_table_name,
       fatt.attname AS foreign_column_name,
       con.confdeltype
     FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord) ON true
     JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = cols.attnum
     JOIN pg_class frel ON frel.oid = con.confrelid
     JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
     JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fcols(attnum, ord) ON fcols.ord = cols.ord
     JOIN pg_attribute fatt ON fatt.attrelid = frel.oid AND fatt.attnum = fcols.attnum
     WHERE nsp.nspname = 'town'
       AND rel.relname = 'signal_submissions'
       AND con.contype = 'f'
     ORDER BY con.conname, cols.ord`,
  );

  const expectedFks = [
    {
      conname: 'signal_submissions_account_id_fkey',
      column_name: 'account_id',
      foreign_table_schema: 'town',
      foreign_table_name: 'accounts',
      foreign_column_name: 'id',
      confdeltype: 'r',
    },
    {
      conname: 'signal_submissions_actor_id_fkey',
      column_name: 'actor_id',
      foreign_table_schema: 'town',
      foreign_table_name: 'actors',
      foreign_column_name: 'id',
      confdeltype: 'r',
    },
    {
      conname: 'signal_submissions_community_id_fkey',
      column_name: 'community_id',
      foreign_table_schema: 'town',
      foreign_table_name: 'communities',
      foreign_column_name: 'id',
      confdeltype: 'r',
    },
    {
      conname: 'signal_submissions_reviewed_by_account_id_fkey',
      column_name: 'reviewed_by_account_id',
      foreign_table_schema: 'town',
      foreign_table_name: 'accounts',
      foreign_column_name: 'id',
      confdeltype: 'r',
    },
  ];

  if (JSON.stringify(foreignKeys.rows) !== JSON.stringify(expectedFks)) {
    throw new StagingInspectionError(
      'SCHEMA_MISMATCH',
      'town.signal_submissions foreign keys do not match expected RESTRICT references',
    );
  }

  const checkConstraint = await queryClient<{ conname: string; definition: string }>(
    client,
    `SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
     FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'town'
       AND rel.relname = 'signal_submissions'
       AND con.contype = 'c'
       AND con.conname = 'signal_submissions_status_valid'`,
  );
  const checkRow = checkConstraint.rows[0];
  if (checkRow === undefined) {
    throw new StagingInspectionError(
      'SCHEMA_MISMATCH',
      'town.signal_submissions missing CHECK constraint signal_submissions_status_valid',
    );
  }
  const definition = checkRow.definition.toLowerCase();
  if (!definition.includes('pending_review') || !definition.includes('rejected')) {
    throw new StagingInspectionError(
      'SCHEMA_MISMATCH',
      'signal_submissions_status_valid must permit pending_review and rejected',
    );
  }
  // Reject definitions that allow literals beyond the moderation-ready statuses.
  const quotedLiterals = [...checkRow.definition.matchAll(/'([^']+)'/g)].map(
    (match) => match[1] ?? '',
  );
  const allowedStatuses = new Set(['pending_review', 'rejected']);
  if (
    quotedLiterals.length !== 2 ||
    quotedLiterals.some((literal) => !allowedStatuses.has(literal))
  ) {
    throw new StagingInspectionError(
      'SCHEMA_MISMATCH',
      'signal_submissions_status_valid must permit exactly pending_review and rejected',
    );
  }

  const indexColumns = await queryClient<{ column_name: string; ordinal_position: number }>(
    client,
    `SELECT a.attname AS column_name, cols.ord::int AS ordinal_position
     FROM pg_class idx
     JOIN pg_namespace nsp ON nsp.oid = idx.relnamespace
     JOIN pg_index i ON i.indexrelid = idx.oid
     JOIN pg_class tbl ON tbl.oid = i.indrelid
     JOIN pg_namespace tnsp ON tnsp.oid = tbl.relnamespace
     JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS cols(attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = tbl.oid AND a.attnum = cols.attnum
     WHERE nsp.nspname = 'town'
       AND tnsp.nspname = 'town'
       AND tbl.relname = 'signal_submissions'
       AND idx.relname = 'signal_submissions_account_created_at_idx'
     ORDER BY cols.ord`,
  );

  const expectedIndex = [
    { column_name: 'account_id', ordinal_position: 1 },
    { column_name: 'created_at', ordinal_position: 2 },
  ];
  if (JSON.stringify(indexColumns.rows) !== JSON.stringify(expectedIndex)) {
    throw new StagingInspectionError(
      'SCHEMA_MISMATCH',
      'signal_submissions_account_created_at_idx must be exactly (account_id, created_at)',
    );
  }
}

async function countRowTotals(client: PoolClient): Promise<StagingInspectionRowCounts> {
  const accountEmails = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.account_emails`,
  );
  const accountSessions = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.account_sessions`,
  );
  const accounts = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.accounts`,
  );
  const actors = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.actors`,
  );
  const ceremonyRateLimits = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.ceremony_rate_limits`,
  );
  const communities = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.communities`,
  );
  const emailChallenges = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.email_challenges`,
  );
  const identitySecurityEvents = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.identity_security_events`,
  );
  const membershipEntitlements = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.membership_entitlements`,
  );
  const membershipSourceEvents = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.membership_source_events`,
  );
  const passkeyCredentials = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.passkey_credentials`,
  );
  const recoveryGrants = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.recovery_grants`,
  );
  const setupGrants = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.setup_grants`,
  );
  const signalConfirmations = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.signal_confirmations`,
  );
  const signalSubmissions = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.signal_submissions`,
  );
  const signals = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.signals`,
  );
  const stripeCheckoutAttempts = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.stripe_checkout_attempts`,
  );
  const stripeCustomerLinks = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.stripe_customer_links`,
  );
  const webauthnChallenges = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM town.webauthn_challenges`,
  );

  return {
    account_emails: Number(accountEmails.rows[0]?.count ?? 0),
    account_sessions: Number(accountSessions.rows[0]?.count ?? 0),
    accounts: Number(accounts.rows[0]?.count ?? 0),
    actors: Number(actors.rows[0]?.count ?? 0),
    ceremony_rate_limits: Number(ceremonyRateLimits.rows[0]?.count ?? 0),
    communities: Number(communities.rows[0]?.count ?? 0),
    email_challenges: Number(emailChallenges.rows[0]?.count ?? 0),
    identity_security_events: Number(identitySecurityEvents.rows[0]?.count ?? 0),
    membership_entitlements: Number(membershipEntitlements.rows[0]?.count ?? 0),
    membership_source_events: Number(membershipSourceEvents.rows[0]?.count ?? 0),
    passkey_credentials: Number(passkeyCredentials.rows[0]?.count ?? 0),
    recovery_grants: Number(recoveryGrants.rows[0]?.count ?? 0),
    setup_grants: Number(setupGrants.rows[0]?.count ?? 0),
    signal_confirmations: Number(signalConfirmations.rows[0]?.count ?? 0),
    signal_submissions: Number(signalSubmissions.rows[0]?.count ?? 0),
    signals: Number(signals.rows[0]?.count ?? 0),
    stripe_checkout_attempts: Number(stripeCheckoutAttempts.rows[0]?.count ?? 0),
    stripe_customer_links: Number(stripeCustomerLinks.rows[0]?.count ?? 0),
    webauthn_challenges: Number(webauthnChallenges.rows[0]?.count ?? 0),
  };
}

async function countEligibilityFinding(client: PoolClient): Promise<number> {
  const result = await queryClient<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count
     FROM town.actors
     WHERE community_id IS NOT NULL
       AND local_eligibility_verified_at IS NULL`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Apply and verify read-only staging inspection under a single client transaction.
 */
export async function runStagingInspection(
  options: RunStagingInspectionOptions = {},
): Promise<StagingInspectionResult> {
  const env = options.env ?? process.env;
  const databaseUrl = requireStagingEnv(env);
  logEvent('env_check', 'ok', { appEnv: 'staging' });

  const createPool =
    options.createPool ??
    ((config) =>
      new Pool({
        connectionString: config.connectionString,
        max: config.max,
        connectionTimeoutMillis: config.connectionTimeoutMillis,
      }));

  const pool = createPool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  let client: PoolClient | undefined;
  let clientAcquired = false;
  let transactionStarted = false;
  let originalError: unknown;
  let releaseError: unknown;
  let poolEndError: unknown;
  let result: StagingInspectionResult | undefined;

  try {
    if (options.injectConnectFailure !== undefined) {
      throw options.injectConnectFailure;
    }
    client = await pool.connect();
    clientAcquired = true;
    logEvent('connect', 'ok');

    if (options.injectBeginFailure !== undefined) {
      throw options.injectBeginFailure;
    }
    await queryClient(client, 'BEGIN TRANSACTION READ ONLY');
    transactionStarted = true;
    logEvent('begin', 'ok');

    if (options.injectSetLocalFailure !== undefined) {
      throw options.injectSetLocalFailure;
    }
    await queryClient(client, `SET LOCAL statement_timeout = '5s'`);
    logEvent('set_timeout', 'ok');

    if (options.afterTransactionReady !== undefined) {
      await options.afterTransactionReady(client);
    }

    if (options.injectCheckFailure !== undefined) {
      throw options.injectCheckFailure;
    }

    await assertSignalSubmissionsSchema(client);
    logEvent('check_schema', 'ok');

    const rowCounts = await countRowTotals(client);
    logEvent('check_counts', 'ok');

    const eligibilityCount = await countEligibilityFinding(client);
    logEvent('check_eligibility', 'ok', {
      actorsBoundMissingLocalEligibilityVerifiedAt: eligibilityCount,
    });

    if (options.injectCommitFailure !== undefined) {
      throw options.injectCommitFailure;
    }
    await queryClient(client, 'COMMIT');
    // Successful COMMIT ends the transaction; do not ROLLBACK afterwards.
    transactionStarted = false;
    logEvent('commit', 'ok');

    result = {
      migrationLedgerChecked: false,
      migrationLedgerAuthority: 'GET /health/ready',
      schemaCheck: {
        table: 'town.signal_submissions',
        status: 'ok',
      },
      rowCounts,
      eligibilityFinding: {
        actorsBoundMissingLocalEligibilityVerifiedAt: eligibilityCount,
      },
    };
    logEvent('complete', 'ok');
  } catch (error: unknown) {
    originalError = error;
    const stage = !clientAcquired
      ? 'connect'
      : !transactionStarted && result === undefined
        ? 'begin'
        : 'error';
    logEvent(stage, 'fail', { reason: errorMessage(error) });

    if (transactionStarted && client !== undefined) {
      try {
        await queryClient(client, 'ROLLBACK');
        if (options.injectRollbackFailure !== undefined) {
          throw options.injectRollbackFailure;
        }
        logEvent('rollback', 'ok');
      } catch (rollbackError: unknown) {
        logEvent('rollback', 'fail', { reason: errorMessage(rollbackError) });
      }
    } else {
      logEvent('rollback', 'skip');
    }
  } finally {
    if (clientAcquired && client !== undefined) {
      try {
        client.release();
        if (options.injectReleaseFailure !== undefined) {
          releaseError = options.injectReleaseFailure;
          logEvent('release', 'fail', { reason: errorMessage(releaseError) });
        } else {
          logEvent('release', 'ok');
        }
      } catch (error: unknown) {
        releaseError = error;
        logEvent('release', 'fail', { reason: errorMessage(error) });
      }

      try {
        await pool.end();
        if (options.injectPoolEndFailure !== undefined) {
          poolEndError = options.injectPoolEndFailure;
          logEvent('pool_end', 'fail', { reason: errorMessage(poolEndError) });
        } else {
          logEvent('pool_end', 'ok');
        }
      } catch (error: unknown) {
        poolEndError = error;
        logEvent('pool_end', 'fail', { reason: errorMessage(error) });
      }
    } else {
      logEvent('release', 'skip');
      try {
        await pool.end();
        if (options.injectPoolEndFailure !== undefined) {
          poolEndError = options.injectPoolEndFailure;
          logEvent('pool_end', 'fail', { reason: errorMessage(poolEndError) });
        } else {
          logEvent('pool_end', 'ok');
        }
      } catch (error: unknown) {
        poolEndError = error;
        logEvent('pool_end', 'fail', { reason: errorMessage(error) });
      }
    }
  }

  if (originalError !== undefined) {
    throw originalError instanceof Error ? originalError : new Error(errorMessage(originalError));
  }
  if (releaseError !== undefined) {
    throw releaseError instanceof Error ? releaseError : new Error(errorMessage(releaseError));
  }
  if (poolEndError !== undefined) {
    throw poolEndError instanceof Error ? poolEndError : new Error(errorMessage(poolEndError));
  }
  if (result === undefined) {
    throw new StagingInspectionError('INSPECTION_FAILED', 'Staging inspection produced no result');
  }
  return result;
}

export function runStagingInspectionCli(env: NodeJS.ProcessEnv = process.env): void {
  runStagingInspection({ env })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = 0;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Staging inspection failed';
      const code = error instanceof StagingInspectionError ? error.code : 'UNEXPECTED';
      process.stderr.write(`${code}: ${message}\n`);
      process.exitCode = 1;
    });
}
