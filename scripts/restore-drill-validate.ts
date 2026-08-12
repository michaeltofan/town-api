import { Pool } from 'pg';

/**
 * Read-only integrity validation for an isolated PITR restore drill (Etapa 3).
 *
 * Connects ONLY to the database named by DATABASE_URL -- this must be the
 * restored sibling service, never the source. The script issues no
 * INSERT/UPDATE/DELETE statements. It prints table row counts and pass/fail
 * checks only -- never any personal data (no emails, names, credential
 * material, or other column values).
 *
 * Usage: DATABASE_URL=<restored-instance-url> tsx scripts/restore-drill-validate.ts
 */

type CheckResult = {
  name: string;
  status: 'ok' | 'fail';
  detail: string;
};

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (must point at the isolated restored instance)');
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
  const results: CheckResult[] = [];

  const check = async (name: string, fn: () => Promise<CheckResult>): Promise<void> => {
    try {
      results.push(await fn());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown error';
      results.push({ name, status: 'fail', detail: message });
    }
  };

  try {
    await check('connectivity', async () => {
      const { rows } = await pool.query<{ db: string; version: string }>(
        'SELECT current_database() AS db, version() AS version',
      );
      return {
        name: 'connectivity',
        status: 'ok',
        detail: `database=${rows[0]?.db ?? 'unknown'}`,
      };
    });

    await check('schema_exists', async () => {
      const { rows } = await pool.query(
        "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'town'",
      );
      return rows.length === 1
        ? { name: 'schema_exists', status: 'ok', detail: 'town schema present' }
        : { name: 'schema_exists', status: 'fail', detail: 'town schema missing' };
    });

    const expectedTables = [
      'communities',
      'accounts',
      'membership_entitlements',
      'platform_operators',
      'actors',
      'civic_processes',
      'civic_proposals',
      'civic_votes',
      'passkey_credentials',
      'account_password_credentials',
      'account_sessions',
    ];

    await check('expected_tables_present', async () => {
      const { rows } = await pool.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'town'",
      );
      const present = new Set(rows.map((r) => r.table_name));
      const missing = expectedTables.filter((t) => !present.has(t));
      return missing.length === 0
        ? {
            name: 'expected_tables_present',
            status: 'ok',
            detail: `${String(expectedTables.length)} tables present`,
          }
        : {
            name: 'expected_tables_present',
            status: 'fail',
            detail: `missing: ${missing.join(', ')}`,
          };
    });

    const countTables: Record<string, string> = {
      communities: 'town.communities',
      accounts: 'town.accounts',
      membership_entitlements: 'town.membership_entitlements',
      platform_operators: 'town.platform_operators',
      actors: 'town.actors',
      civic_processes: 'town.civic_processes',
      civic_proposals: 'town.civic_proposals',
      civic_votes: 'town.civic_votes',
      passkey_credentials: 'town.passkey_credentials',
      account_password_credentials: 'town.account_password_credentials',
      account_sessions: 'town.account_sessions',
    };
    const counts: Record<string, number> = {};

    for (const [label, table] of Object.entries(countTables)) {
      await check(`count_${label}`, async () => {
        const { rows } = await pool.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM ${table}`,
        );
        const count = rows[0]?.count ?? 0;
        counts[label] = count;
        return { name: `count_${label}`, status: 'ok', detail: `${String(count)} rows` };
      });
    }

    // Orphan / foreign-key integrity spot checks -- accounts, memberships,
    // roles (platform_operators), communities, actors, civic processes.
    const orphanChecks: { name: string; sql: string }[] = [
      {
        name: 'orphan_membership_entitlements_account',
        sql: `SELECT COUNT(*)::int AS count FROM town.membership_entitlements m
              LEFT JOIN town.accounts a ON a.id = m.account_id WHERE a.id IS NULL`,
      },
      {
        name: 'orphan_platform_operators_account',
        sql: `SELECT COUNT(*)::int AS count FROM town.platform_operators p
              LEFT JOIN town.accounts a ON a.id = p.account_id WHERE a.id IS NULL`,
      },
      {
        name: 'orphan_actors_account',
        sql: `SELECT COUNT(*)::int AS count FROM town.actors x
              LEFT JOIN town.accounts a ON a.id = x.account_id
              WHERE x.account_id IS NOT NULL AND a.id IS NULL`,
      },
      {
        name: 'orphan_actors_community',
        sql: `SELECT COUNT(*)::int AS count FROM town.actors x
              LEFT JOIN town.communities c ON c.id = x.community_id
              WHERE x.community_id IS NOT NULL AND c.id IS NULL`,
      },
      {
        name: 'orphan_civic_proposals_process',
        sql: `SELECT COUNT(*)::int AS count FROM town.civic_proposals p
              LEFT JOIN town.civic_processes pr ON pr.id = p.process_id WHERE pr.id IS NULL`,
      },
      {
        name: 'orphan_civic_proposals_author_actor',
        sql: `SELECT COUNT(*)::int AS count FROM town.civic_proposals p
              LEFT JOIN town.actors x ON x.id = p.author_actor_id WHERE x.id IS NULL`,
      },
      {
        name: 'orphan_civic_processes_community',
        sql: `SELECT COUNT(*)::int AS count FROM town.civic_processes pr
              LEFT JOIN town.communities c ON c.id = pr.community_id WHERE c.id IS NULL`,
      },
    ];

    for (const { name, sql } of orphanChecks) {
      await check(name, async () => {
        const { rows } = await pool.query<{ count: number }>(sql);
        const count = rows[0]?.count ?? 0;
        return count === 0
          ? { name, status: 'ok', detail: '0 orphans' }
          : { name, status: 'fail', detail: `${String(count)} orphan rows` };
      });
    }

    // Authentication data structural integrity -- proves credential material
    // survived the restore and is queryable, without decoding or printing it,
    // and without connecting any application to this instance.
    await check('auth_passkey_material_present', async () => {
      const { rows } = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM town.passkey_credentials
         WHERE credential_id IS NULL OR public_key IS NULL OR octet_length(public_key) = 0`,
      );
      const bad = rows[0]?.count ?? 0;
      return bad === 0
        ? {
            name: 'auth_passkey_material_present',
            status: 'ok',
            detail: 'all rows have credential material',
          }
        : {
            name: 'auth_passkey_material_present',
            status: 'fail',
            detail: `${String(bad)} rows missing credential material`,
          };
    });

    await check('auth_password_hash_present', async () => {
      const { rows } = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM town.account_password_credentials
         WHERE password_hash IS NULL OR password_hash = ''`,
      );
      const bad = rows[0]?.count ?? 0;
      return bad === 0
        ? {
            name: 'auth_password_hash_present',
            status: 'ok',
            detail: 'all rows have a password hash',
          }
        : {
            name: 'auth_password_hash_present',
            status: 'fail',
            detail: `${String(bad)} rows missing a password hash`,
          };
    });

    const failed = results.filter((r) => r.status === 'fail');
    const summary = {
      outcome: failed.length === 0 ? 'passed' : 'failed',
      checks: results,
      counts,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (failed.length > 0) {
      process.stderr.write(
        `Restore drill validation FAILED: ${failed.map((f) => f.name).join(', ')}\n`,
      );
      process.exit(1);
    }
    process.stderr.write('Restore drill validation PASSED\n');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore drill validation crashed';
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
