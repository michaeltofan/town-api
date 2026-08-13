import { readFileSync, unlinkSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { requireDatabaseUrl, requireStagingEnv } from './lib/env.js';

/**
 * Etapa 4 load-test teardown -- STAGING ONLY.
 *
 * Deletes exactly what `loadtest/provision.ts` created for one run (the
 * ephemeral pool: two communities, their signals, their accounts, and
 * whatever confirmations/proposals k6 wrote against them) and nothing
 * else. Never touches the permanent voting-arena fixture from
 * `loadtest/ensure-voting-arena.ts` (a different manifest, never read
 * here) or any real staging content.
 *
 * Runs as one transaction: if anything looks wrong partway through,
 * everything rolls back rather than leaving staging half-cleaned.
 *
 * Safety check before deleting anything: `civic_ballot_eligible_actors` is
 * append-only (see src/db/seeds/loadtest-voting-arena.ts) -- a signal that
 * reached 'ballot_preparation' can never have its eligible-voter snapshot
 * deleted, which would make this whole community/signal/actor chain
 * permanently undeletable. provision.ts's k6 journey never submits
 * deliberation contributions for the ephemeral pool, so no ephemeral
 * signal should ever reach that stage -- but if one somehow did, this
 * script refuses to run rather than hitting that wall mid-transaction.
 *
 * Idempotent: safe to run against a pool that's already torn down (or was
 * never provisioned -- a missing manifest is a no-op, not an error).
 *
 * Account IDs to delete are the union of the manifest's account list and
 * whatever `actors` rows are actually linked to the ephemeral communities
 * in the database -- not the manifest alone. `provision.ts` links each
 * actor to its account before the final 'active' transition, so a run
 * that crashes partway through account provisioning (after the manifest
 * would have been written) still leaves a fully discoverable, fully
 * teardownable account via its actor's community_id.
 */

type Manifest = {
  communityA: { id: string };
  communityB: { id: string };
  accounts: { accountId: string }[];
};

type DeleteResult = { table: string; deleted: number };

async function runTeardown(): Promise<void> {
  requireStagingEnv(process.env);
  const databaseUrl = requireDatabaseUrl(process.env);
  const manifestPath = process.env.LOADTEST_MANIFEST_PATH ?? 'loadtest/.manifest.json';

  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      process.stdout.write(
        JSON.stringify({ outcome: 'noop', reason: `no manifest at ${manifestPath}` }) + '\n',
      );
      return;
    }
    throw error;
  }

  const communityIds = [manifest.communityA.id, manifest.communityB.id];
  const manifestAccountIds = manifest.accounts.map((a) => a.accountId);

  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
  const client: PoolClient = await pool.connect();
  const results: DeleteResult[] = [];

  const del = async (table: string, sql: string, params: unknown[]): Promise<void> => {
    const res = await client.query(sql, params);
    results.push({ table, deleted: res.rowCount ?? 0 });
  };

  try {
    await client.query('BEGIN');

    const linkedAccounts = await client.query<{ account_id: string }>(
      `SELECT DISTINCT account_id FROM town.actors
       WHERE community_id = ANY($1::uuid[]) AND account_id IS NOT NULL`,
      [communityIds],
    );
    const accountIds = [
      ...new Set([...manifestAccountIds, ...linkedAccounts.rows.map((r) => r.account_id)]),
    ];

    const eligibleActorsCheck = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM town.civic_ballot_eligible_actors t
       JOIN town.civic_processes pr ON pr.id = t.process_id
       WHERE pr.community_id = ANY($1::uuid[])`,
      [communityIds],
    );
    const eligibleActorsCount = Number(eligibleActorsCheck.rows[0]?.count ?? 0);
    if (eligibleActorsCount > 0) {
      throw new Error(
        `Refusing to tear down: ${String(eligibleActorsCount)} row(s) in civic_ballot_eligible_actors ` +
          `for the ephemeral load-test communities -- that table is append-only and its presence means ` +
          `a signal reached 'ballot_preparation', which the ephemeral pool's k6 journey should never trigger. ` +
          `Investigate before touching this data; it cannot be deleted.`,
      );
    }

    // Deepest children first, matching every RESTRICT foreign key in the
    // schema. Most of these are expected to delete 0 rows for the
    // ephemeral pool (votes/tokens/deliberation never happen here) --
    // included anyway so this script stays correct if the k6 scenario ever
    // grows to touch them.
    await del(
      'civic_votes',
      `DELETE FROM town.civic_votes v USING town.civic_processes pr
       WHERE pr.id = v.process_id AND pr.community_id = ANY($1::uuid[])`,
      [communityIds],
    );
    await del(
      'civic_ballot_tokens',
      `DELETE FROM town.civic_ballot_tokens t USING town.civic_processes pr
       WHERE pr.id = t.process_id AND pr.community_id = ANY($1::uuid[])`,
      [communityIds],
    );
    await del(
      'civic_deliberation_contributions',
      `DELETE FROM town.civic_deliberation_contributions c USING town.civic_processes pr
       WHERE pr.id = c.process_id AND pr.community_id = ANY($1::uuid[])`,
      [communityIds],
    );
    await del(
      'civic_proposals',
      `DELETE FROM town.civic_proposals p USING town.civic_processes pr
       WHERE pr.id = p.process_id AND pr.community_id = ANY($1::uuid[])`,
      [communityIds],
    );
    await del(
      'civic_process_events',
      `DELETE FROM town.civic_process_events e USING town.civic_processes pr
       WHERE pr.id = e.process_id AND pr.community_id = ANY($1::uuid[])`,
      [communityIds],
    );
    await del(
      'civic_processes',
      `DELETE FROM town.civic_processes WHERE community_id = ANY($1::uuid[])`,
      [communityIds],
    );
    await del(
      'signal_confirmations',
      `DELETE FROM town.signal_confirmations sc USING town.signals s
       WHERE s.id = sc.signal_id AND s.community_id = ANY($1::uuid[])`,
      [communityIds],
    );
    await del('signals', `DELETE FROM town.signals WHERE community_id = ANY($1::uuid[])`, [
      communityIds,
    ]);

    await del(
      'account_sessions',
      `DELETE FROM town.account_sessions WHERE account_id = ANY($1::uuid[])`,
      [accountIds],
    );
    await del(
      'passkey_credentials',
      `DELETE FROM town.passkey_credentials WHERE account_id = ANY($1::uuid[])`,
      [accountIds],
    );
    await del(
      'account_password_credentials',
      `DELETE FROM town.account_password_credentials WHERE account_id = ANY($1::uuid[])`,
      [accountIds],
    );
    await del(
      'account_emails',
      `DELETE FROM town.account_emails WHERE account_id = ANY($1::uuid[])`,
      [accountIds],
    );
    await del('actors', `DELETE FROM town.actors WHERE community_id = ANY($1::uuid[])`, [
      communityIds,
    ]);
    await del('accounts', `DELETE FROM town.accounts WHERE id = ANY($1::uuid[])`, [accountIds]);
    await del('communities', `DELETE FROM town.communities WHERE id = ANY($1::uuid[])`, [
      communityIds,
    ]);

    await client.query('COMMIT');

    try {
      unlinkSync(manifestPath);
    } catch {
      // Not fatal -- the DB is already clean, which is what matters.
    }

    process.stdout.write(`${JSON.stringify({ outcome: 'torn_down', deleted: results })}\n`);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Already rolled back or connection lost -- nothing more to do.
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runTeardown().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : 'Teardown failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
