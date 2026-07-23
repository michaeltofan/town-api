import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StagingInspectionError,
  runStagingInspection,
  runStagingInspectionCli,
  type StagingInspectionResult,
} from '../src/db/run-staging-inspection.js';
import type { Pool, PoolClient, QueryResult } from 'pg';

type QueryCall = { readonly text: string; readonly values?: unknown[] };

function emptyResult<T extends Record<string, unknown>>(rows: T[] = []): QueryResult<T> {
  return {
    rows,
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
  };
}

function schemaOkQueryHandler(text: string): QueryResult<Record<string, unknown>> {
  if (text.includes('information_schema.columns')) {
    return emptyResult([
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'account_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'actor_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'community_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'headline', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'body', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'status', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
    ]);
  }
  if (text.includes("con.contype = 'p'")) {
    return emptyResult([{ column_name: 'id' }]);
  }
  if (text.includes("con.contype = 'f'")) {
    return emptyResult([
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
    ]);
  }
  if (text.includes('signal_submissions_status_valid')) {
    return emptyResult([
      {
        conname: 'signal_submissions_status_valid',
        definition: `CHECK ((status = 'pending_review'::text))`,
      },
    ]);
  }
  if (text.includes('signal_submissions_account_created_at_idx')) {
    return emptyResult([
      { column_name: 'account_id', ordinal_position: 1 },
      { column_name: 'created_at', ordinal_position: 2 },
    ]);
  }
  if (text.includes('local_eligibility_verified_at IS NULL')) {
    return emptyResult([{ count: '3' }]);
  }
  if (text.includes('COUNT(*)') && text.includes('FROM town.')) {
    return emptyResult([{ count: '0' }]);
  }
  if (
    text === 'BEGIN TRANSACTION READ ONLY' ||
    text === `SET LOCAL statement_timeout = '5s'` ||
    text === 'COMMIT' ||
    text === 'ROLLBACK'
  ) {
    return emptyResult();
  }
  throw new Error(`unexpected query in mock: ${text}`);
}

function createFakeClient(options?: {
  queryImpl?: (
    text: string,
    values?: unknown[],
  ) => QueryResult<Record<string, unknown>> | Promise<QueryResult<Record<string, unknown>>>;
  releaseImpl?: () => void;
}): {
  client: PoolClient;
  queries: QueryCall[];
  release: ReturnType<typeof vi.fn>;
} {
  const queries: QueryCall[] = [];
  const release = vi.fn(() => {
    options?.releaseImpl?.();
  });
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push(values === undefined ? { text } : { text, values });
      if (options?.queryImpl !== undefined) {
        return options.queryImpl(text, values);
      }
      return schemaOkQueryHandler(text);
    }),
    release,
  } as unknown as PoolClient;
  return { client, queries, release };
}

function createFakePool(options: {
  connectImpl: () => Promise<PoolClient>;
  endImpl?: () => Promise<void>;
}): {
  pool: Pool;
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
} {
  const connect = vi.fn(options.connectImpl);
  const end = vi.fn(async () => {
    if (options.endImpl !== undefined) {
      await options.endImpl();
    }
  });
  const query = vi.fn(() => {
    return Promise.reject(new Error('pool.query must never be called'));
  });
  const pool = Object.assign(new EventEmitter(), {
    connect,
    end,
    query,
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    expiredCount: 0,
    ending: false,
    ended: false,
    options: {},
  }) as unknown as Pool;
  return { pool, connect, end, query };
}

const stagingEnv = {
  APP_ENV: 'staging',
  DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town_inspect_test',
} as const;

describe('staging inspection environment gate', () => {
  it('T2 refuses development/test/production/unset without connecting', async () => {
    const createPool = vi.fn(() => {
      throw new Error('createPool must not run before APP_ENV gate');
    });

    for (const appEnv of ['development', 'test', 'production', undefined] as const) {
      const env: NodeJS.ProcessEnv = {
        DATABASE_URL: stagingEnv.DATABASE_URL,
      };
      if (appEnv !== undefined) {
        env.APP_ENV = appEnv;
      } else {
        delete env.APP_ENV;
      }
      await expect(
        runStagingInspection({
          env,
          createPool,
        }),
      ).rejects.toMatchObject({
        code: 'APP_ENV_NOT_STAGING',
      } satisfies Partial<StagingInspectionError>);
      expect(createPool).not.toHaveBeenCalled();
    }
  });

  it('refuses missing DATABASE_URL under staging before connecting', async () => {
    const createPool = vi.fn(() => {
      throw new Error('createPool must not run without DATABASE_URL');
    });
    await expect(
      runStagingInspection({
        env: { APP_ENV: 'staging' },
        createPool,
      }),
    ).rejects.toMatchObject({ code: 'DATABASE_URL_REQUIRED' });
    expect(createPool).not.toHaveBeenCalled();
  });
});

describe('staging inspection single-client and timeout behaviour', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T3 issues SET LOCAL statement_timeout on the transaction client', async () => {
    const { client, queries, release } = createFakeClient();
    const { pool, connect, end, query } = createFakePool({
      connectImpl: () => Promise.resolve(client),
    });

    await runStagingInspection({
      env: stagingEnv,
      createPool: () => pool,
    });

    expect(queries.some((call) => call.text === `SET LOCAL statement_timeout = '5s'`)).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('T4 routes every query through the one client; pool.query never; connect once', async () => {
    const { client, queries, release } = createFakeClient();
    const { pool, connect, end, query } = createFakePool({
      connectImpl: () => Promise.resolve(client),
    });

    await runStagingInspection({
      env: stagingEnv,
      createPool: () => pool,
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(queries.length).toBeGreaterThan(0);
    expect(queries[0]?.text).toBe('BEGIN TRANSACTION READ ONLY');
    expect(queries.some((call) => call.text === 'COMMIT')).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe('staging inspection cleanup precedence', () => {
  it('T5 rolls back, releases, and ends pool when a check throws', async () => {
    const { client, queries, release } = createFakeClient();
    const { pool, connect, end, query } = createFakePool({
      connectImpl: () => Promise.resolve(client),
    });
    const checkError = new StagingInspectionError('INSPECTION_FAILED', 'injected check failure');

    await expect(
      runStagingInspection({
        env: stagingEnv,
        createPool: () => pool,
        injectCheckFailure: checkError,
      }),
    ).rejects.toBe(checkError);

    expect(queries.some((call) => call.text === 'ROLLBACK')).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it('T12A CASE 1: original check error wins over rollback/release/pool.end failures', async () => {
    const stderr: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    const checkError = new Error('original-check-error');
    const { client, release } = createFakeClient();
    const { pool, end, query, connect } = createFakePool({
      connectImpl: () => Promise.resolve(client),
    });

    await expect(
      runStagingInspection({
        env: stagingEnv,
        createPool: () => pool,
        injectCheckFailure: checkError,
        injectRollbackFailure: new Error('rollback-failed'),
        injectReleaseFailure: new Error('release-failed'),
        injectPoolEndFailure: new Error('pool-end-failed'),
      }),
    ).rejects.toBe(checkError);

    expect(end).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(stderr.join('')).toMatch(/rollback/);
    expect(stderr.join('')).toMatch(/release/);
    expect(stderr.join('')).toMatch(/pool_end/);
    writeSpy.mockRestore();
  });

  it('T12B CASE 2: release failure propagates; pool.end still attempted; exit path is failure', async () => {
    const { client, release } = createFakeClient();
    const { pool, end, query } = createFakePool({
      connectImpl: () => Promise.resolve(client),
    });

    await expect(
      runStagingInspection({
        env: stagingEnv,
        createPool: () => pool,
        injectReleaseFailure: new Error('release-failed'),
      }),
    ).rejects.toThrow(/release-failed/);

    expect(release).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it('T12C CASE 3: pool.end failure propagates when release succeeds', async () => {
    const { client, release } = createFakeClient();
    const { pool, end, query } = createFakePool({
      connectImpl: () => Promise.resolve(client),
    });

    await expect(
      runStagingInspection({
        env: stagingEnv,
        createPool: () => pool,
        injectPoolEndFailure: new Error('pool-end-failed'),
      }),
    ).rejects.toThrow(/pool-end-failed/);

    expect(release).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it('T12D CASE 4: release failure wins when both release and pool.end fail', async () => {
    const stderr: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    const { client } = createFakeClient();
    const { pool, end, query } = createFakePool({
      connectImpl: () => Promise.resolve(client),
    });

    await expect(
      runStagingInspection({
        env: stagingEnv,
        createPool: () => pool,
        injectReleaseFailure: new Error('release-failed'),
        injectPoolEndFailure: new Error('pool-end-failed'),
      }),
    ).rejects.toThrow(/release-failed/);

    expect(end).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(stderr.join('')).toMatch(/pool-end-failed|pool_end/);
    writeSpy.mockRestore();
  });

  it('T12E CASE 5: success returns result and does not fail', async () => {
    const { client } = createFakeClient();
    const { pool, query } = createFakePool({
      connectImpl: () => Promise.resolve(client),
    });

    const result = await runStagingInspection({
      env: stagingEnv,
      createPool: () => pool,
    });

    expect(result.migrationLedgerChecked).toBe(false);
    expect(result.migrationLedgerAuthority).toBe('GET /health/ready');
    expect(result.schemaCheck.status).toBe('ok');
    expect(result.eligibilityFinding.actorsBoundMissingLocalEligibilityVerifiedAt).toBe(3);
    expect(query).not.toHaveBeenCalled();
  });

  it('T13A CASE 0A: connect failure ends pool, skips release and rollback, preserves error', async () => {
    const connectError = new Error('connect-failed');
    const { client, release, queries } = createFakeClient();
    const { pool, end, connect, query } = createFakePool({
      connectImpl: () => Promise.resolve(client),
    });

    await expect(
      runStagingInspection({
        env: stagingEnv,
        createPool: () => pool,
        injectConnectFailure: connectError,
      }),
    ).rejects.toBe(connectError);

    expect(connect).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(queries.some((call) => call.text === 'ROLLBACK')).toBe(false);
    expect(end).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it('T13B CASE 0B: BEGIN failure releases client, ends pool, skips rollback', async () => {
    const beginError = new Error('begin-failed');
    const { client, release, queries } = createFakeClient();
    const { pool, end, connect, query } = createFakePool({
      connectImpl: () => Promise.resolve(client),
    });

    await expect(
      runStagingInspection({
        env: stagingEnv,
        createPool: () => pool,
        injectBeginFailure: beginError,
      }),
    ).rejects.toBe(beginError);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(queries.some((call) => call.text === 'ROLLBACK')).toBe(false);
    expect(end).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('staging inspection output contract', () => {
  it('T7 non-zero eligibility count still succeeds', async () => {
    const { client } = createFakeClient({
      queryImpl: (text: string) => {
        if (text.includes('local_eligibility_verified_at IS NULL')) {
          return emptyResult([{ count: '12' }]);
        }
        return schemaOkQueryHandler(text);
      },
    });
    const { pool } = createFakePool({
      connectImpl: () => Promise.resolve(client),
    });

    const result = await runStagingInspection({
      env: stagingEnv,
      createPool: () => pool,
    });
    expect(result.eligibilityFinding.actorsBoundMissingLocalEligibilityVerifiedAt).toBe(12);
  });

  it('T8 schema mismatch rejects', async () => {
    const { client } = createFakeClient({
      queryImpl: (text: string) => {
        if (text.includes('information_schema.columns')) {
          return emptyResult([
            { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
            { column_name: 'account_id', data_type: 'uuid', is_nullable: 'NO' },
            { column_name: 'actor_id', data_type: 'uuid', is_nullable: 'NO' },
            { column_name: 'community_id', data_type: 'uuid', is_nullable: 'NO' },
            { column_name: 'headline', data_type: 'text', is_nullable: 'NO' },
            { column_name: 'body', data_type: 'text', is_nullable: 'NO' },
            { column_name: 'status', data_type: 'text', is_nullable: 'NO' },
            { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
            { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
          ]);
        }
        return schemaOkQueryHandler(text);
      },
    });
    const { pool } = createFakePool({
      connectImpl: () => Promise.resolve(client),
    });

    await expect(
      runStagingInspection({
        env: stagingEnv,
        createPool: () => pool,
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
  });

  it('T8 foreign key delete rule mismatch rejects', async () => {
    const { client } = createFakeClient({
      queryImpl: (text: string) => {
        if (text.includes("con.contype = 'f'")) {
          return emptyResult([
            {
              conname: 'signal_submissions_account_id_fkey',
              column_name: 'account_id',
              foreign_table_schema: 'town',
              foreign_table_name: 'accounts',
              foreign_column_name: 'id',
              confdeltype: 'c',
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
          ]);
        }
        return schemaOkQueryHandler(text);
      },
    });
    const { pool } = createFakePool({
      connectImpl: () => Promise.resolve(client),
    });

    await expect(
      runStagingInspection({
        env: stagingEnv,
        createPool: () => pool,
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
  });

  it('T8 CHECK constraint permitting extra value rejects', async () => {
    const { client } = createFakeClient({
      queryImpl: (text: string) => {
        if (text.includes('signal_submissions_status_valid')) {
          return emptyResult([
            {
              conname: 'signal_submissions_status_valid',
              definition: `CHECK ((status = ANY (ARRAY['pending_review'::text, 'approved'::text])))`,
            },
          ]);
        }
        return schemaOkQueryHandler(text);
      },
    });
    const { pool } = createFakePool({
      connectImpl: () => Promise.resolve(client),
    });

    await expect(
      runStagingInspection({
        env: stagingEnv,
        createPool: () => pool,
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
  });

  it('T8 index column order mismatch rejects', async () => {
    const { client } = createFakeClient({
      queryImpl: (text: string) => {
        if (text.includes('signal_submissions_account_created_at_idx')) {
          return emptyResult([
            { column_name: 'created_at', ordinal_position: 1 },
            { column_name: 'account_id', ordinal_position: 2 },
          ]);
        }
        return schemaOkQueryHandler(text);
      },
    });
    const { pool } = createFakePool({
      connectImpl: () => Promise.resolve(client),
    });

    await expect(
      runStagingInspection({
        env: stagingEnv,
        createPool: () => pool,
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
  });

  it('T9/T10/T11 CLI stdout is only parseable JSON with ledger disclaimer and no row data', async () => {
    const { client } = createFakeClient();
    const { pool } = createFakePool({
      connectImpl: () => Promise.resolve(client),
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    const result = await runStagingInspection({
      env: stagingEnv,
      createPool: () => pool,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 0;

    const stdout = stdoutChunks.join('');
    expect(stdout.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(stdout.trim()) as StagingInspectionResult;
    expect(parsed.migrationLedgerChecked).toBe(false);
    expect(parsed.migrationLedgerAuthority).toBe('GET /health/ready');
    expect(stdout).not.toMatch(/@/);
    expect(stdout).not.toMatch(/postgres:\/\//i);
    expect(stdout).not.toMatch(/"password"/i);
    expect(stdout).not.toMatch(/"token"/i);
    expect(stdout).not.toMatch(/"secret"/i);
    expect(parsed).not.toHaveProperty('rows');
    expect(parsed).not.toHaveProperty('email');

    runStagingInspectionCli({ APP_ENV: 'development' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(process.exitCode).toBe(1);
    expect(stderrChunks.join('')).toMatch(/APP_ENV_NOT_STAGING/);

    process.exitCode = previousExitCode;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});
