import { Pool } from 'pg';
import {
  arenaCommunity,
  arenaAccounts,
  arenaSignalIds,
  capacityDrillCycleFromEnv,
  communityA,
  communityB,
  mainAccountsA,
  mainSignalIdsA,
} from './capacity-drill/fixtures.js';

/**
 * Etapa 4 capacity drill post-run integrity verification -- read-only,
 * isolated temporary database only.
 *
 * The spec's closing bar is "zero voturi sau plati duplicate, zero scrieri
 * pierdute si zero acces cross-community." Every one of those invariants is
 * already enforced by a DB-level UNIQUE constraint or an application-level
 * gate -- this script's job is to produce evidence those mechanisms held
 * under the concurrent load k6 just generated, by querying the rows they
 * produced, not by trusting the constraints exist.
 *
 * Prints a single JSON summary line under the unique `capacityVerifyResult`
 * key (outcome/checks/counts) -- kept unique rather than a generic
 * `outcome` field so the orchestrating workflow's log parser can never
 * confuse it with an unrelated `outcome`-bearing log line from elsewhere in
 * the deployment's output.
 */

export type CapacityVerifyResult = {
  outcome: 'passed' | 'failed';
  cycle: 1 | 2;
  observedAt: string;
  checks: Array<{ name: string; status: 'ok' | 'fail'; detail: string }>;
  counts: Record<string, number>;
};

type CheckResult = CapacityVerifyResult['checks'][number];

export async function collectCapacityVerifyResult(
  pool: Pool,
  cycle = capacityDrillCycleFromEnv(),
): Promise<CapacityVerifyResult> {
  const poolCommunityIds = [communityA(cycle).id, communityB(cycle).id];
  const arenaCommunityId = arenaCommunity(cycle).id;
  const allCommunityIds = [...poolCommunityIds, arenaCommunityId];

  const results: CheckResult[] = [];
  const counts: Record<string, number> = {};

  const check = async (name: string, fn: () => Promise<CheckResult>): Promise<void> => {
    try {
      results.push(await fn());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown error';
      results.push({ name, status: 'fail', detail: message });
    }
  };

  const countCheck = async (
    name: string,
    label: string,
    sql: string,
    params: unknown[],
  ): Promise<void> => {
    await check(name, async () => {
      const { rows } = await pool.query<{ count: string }>(sql, params);
      const bad = Number(rows[0]?.count ?? 0);
      return bad === 0
        ? { name, status: 'ok', detail: `0 ${label}` }
        : { name, status: 'fail', detail: `${String(bad)} ${label}` };
    });
  };

  {
    await check('scope_communities_present', async () => {
      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM town.communities WHERE id = ANY($1::uuid[])',
        [allCommunityIds],
      );
      const found = Number(rows[0]?.count ?? 0);
      return found === allCommunityIds.length
        ? { name: 'scope_communities_present', status: 'ok', detail: `${String(found)}/3 present` }
        : {
            name: 'scope_communities_present',
            status: 'fail',
            detail: `only ${String(found)}/3 capacity-drill communities found`,
          };
    });

    await check('preflight_writes_present', async () => {
      const fixtures = [
        {
          label: 'real',
          mainAccount: mainAccountsA(cycle)[4],
          mainSignalId: mainSignalIdsA(cycle)[0],
          arenaAccount: arenaAccounts(cycle)[5],
          arenaSignalId: arenaSignalIds(cycle)[0],
          proposalTitle: 'Capacity drill preflight proposal',
        },
        {
          label: 'synthetic',
          mainAccount: mainAccountsA(cycle)[5],
          mainSignalId: mainSignalIdsA(cycle)[1],
          arenaAccount: arenaAccounts(cycle)[6],
          arenaSignalId: arenaSignalIds(cycle)[1],
          proposalTitle: 'Capacity drill synthetic preflight proposal',
        },
      ];

      const observed: Record<string, { confirmation: number; proposal: number; vote: number }> = {};
      for (const fixture of fixtures) {
        if (
          !fixture.mainAccount ||
          !fixture.mainSignalId ||
          !fixture.arenaAccount ||
          !fixture.arenaSignalId
        ) {
          throw new Error(`Capacity ${fixture.label} preflight fixtures are incomplete`);
        }
        const [confirmation, proposal, vote] = await Promise.all([
          pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM town.signal_confirmations
             WHERE signal_id = $1 AND actor_id = $2`,
            [fixture.mainSignalId, fixture.mainAccount.actorId],
          ),
          pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM town.civic_proposals p
             JOIN town.civic_processes pr ON pr.id = p.process_id
             WHERE pr.signal_id = $1 AND p.author_actor_id = $2 AND p.title = $3`,
            [fixture.mainSignalId, fixture.mainAccount.actorId, fixture.proposalTitle],
          ),
          pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM town.civic_ballot_tokens t
             JOIN town.civic_processes pr ON pr.id = t.process_id
             WHERE pr.signal_id = $1 AND t.actor_id = $2 AND t.consumed_at IS NOT NULL`,
            [fixture.arenaSignalId, fixture.arenaAccount.actorId],
          ),
        ]);
        observed[fixture.label] = {
          confirmation: Number(confirmation.rows[0]?.count ?? 0),
          proposal: Number(proposal.rows[0]?.count ?? 0),
          vote: Number(vote.rows[0]?.count ?? 0),
        };
      }

      const passed = Object.values(observed).every((entry) =>
        Object.values(entry).every((count) => count === 1),
      );
      return {
        name: 'preflight_writes_present',
        status: passed ? 'ok' : 'fail',
        detail: Object.entries(observed)
          .map(
            ([label, entry]) =>
              `${label}:confirmation=${String(entry.confirmation)} proposal=${String(entry.proposal)} vote=${String(entry.vote)}`,
          )
          .join(' | '),
      };
    });

    await countCheck(
      'no_duplicate_confirmations',
      'duplicate (signal_id, actor_id) confirmation pairs',
      `SELECT count(*)::text AS count FROM (
         SELECT sc.signal_id, sc.actor_id
         FROM town.signal_confirmations sc
         JOIN town.signals s ON s.id = sc.signal_id
         WHERE s.community_id = ANY($1::uuid[])
         GROUP BY sc.signal_id, sc.actor_id
         HAVING count(*) > 1
       ) dupes`,
      [poolCommunityIds],
    );

    await countCheck(
      'no_cross_community_confirmations',
      'cross-community confirmation rows',
      `SELECT count(*)::text AS count FROM town.signal_confirmations sc
       JOIN town.actors a ON a.id = sc.actor_id
       JOIN town.signals s ON s.id = sc.signal_id
       WHERE (a.community_id = ANY($1::uuid[]) OR s.community_id = ANY($1::uuid[]))
         AND a.community_id IS DISTINCT FROM s.community_id`,
      [allCommunityIds],
    );

    await countCheck(
      'no_duplicate_proposals',
      'duplicate (process_id, author_actor_id) proposal pairs',
      `SELECT count(*)::text AS count FROM (
         SELECT p.process_id, p.author_actor_id
         FROM town.civic_proposals p
         JOIN town.civic_processes pr ON pr.id = p.process_id
         WHERE pr.community_id = ANY($1::uuid[])
         GROUP BY p.process_id, p.author_actor_id
         HAVING count(*) > 1
       ) dupes`,
      [poolCommunityIds],
    );

    await countCheck(
      'no_cross_community_proposals',
      'cross-community proposal rows',
      `SELECT count(*)::text AS count FROM town.civic_proposals p
       JOIN town.actors a ON a.id = p.author_actor_id
       JOIN town.civic_processes pr ON pr.id = p.process_id
       WHERE (a.community_id = ANY($1::uuid[]) OR pr.community_id = ANY($1::uuid[]))
         AND a.community_id IS DISTINCT FROM pr.community_id`,
      [poolCommunityIds],
    );

    await countCheck(
      'no_duplicate_ballot_tokens',
      'duplicate (process_id, actor_id, ballot_cycle) token rows',
      `SELECT count(*)::text AS count FROM (
         SELECT t.process_id, t.actor_id, t.ballot_cycle
         FROM town.civic_ballot_tokens t
         JOIN town.civic_processes pr ON pr.id = t.process_id
         WHERE pr.community_id = $1
         GROUP BY t.process_id, t.actor_id, t.ballot_cycle
         HAVING count(*) > 1
       ) dupes`,
      [arenaCommunityId],
    );

    await countCheck(
      'no_cross_community_ballot_tokens',
      'cross-community ballot token rows',
      `SELECT count(*)::text AS count FROM town.civic_ballot_tokens t
       JOIN town.actors a ON a.id = t.actor_id
       JOIN town.civic_processes pr ON pr.id = t.process_id
       WHERE pr.community_id = $1 AND a.community_id IS DISTINCT FROM pr.community_id`,
      [arenaCommunityId],
    );

    await check('vote_token_consistency', async () => {
      const { rows } = await pool.query<{
        process_id: string;
        ballot_cycle: number;
        consumed_tokens: string;
        vote_rows: string;
      }>(
        `SELECT
           t.process_id,
           t.ballot_cycle,
           count(*) FILTER (WHERE t.consumed_at IS NOT NULL)::text AS consumed_tokens,
           (
             SELECT count(*) FROM town.civic_votes v
             WHERE v.process_id = t.process_id AND v.ballot_cycle = t.ballot_cycle
           )::text AS vote_rows
         FROM town.civic_ballot_tokens t
         JOIN town.civic_processes pr ON pr.id = t.process_id
         WHERE pr.community_id = $1
         GROUP BY t.process_id, t.ballot_cycle`,
        [arenaCommunityId],
      );
      const mismatched = rows.filter((r) => r.consumed_tokens !== r.vote_rows);
      counts.vote_processes_checked = rows.length;
      return mismatched.length === 0
        ? {
            name: 'vote_token_consistency',
            status: 'ok',
            detail: `${String(rows.length)} arena processes, consumed tokens == vote rows in every one`,
          }
        : {
            name: 'vote_token_consistency',
            status: 'fail',
            detail: `${String(mismatched.length)}/${String(rows.length)} processes have consumed-token/vote-row mismatch`,
          };
    });

    results.push({
      name: 'no_duplicate_payments',
      status: 'ok',
      detail:
        'N/A: capacity-drill accounts bypass the payment gate entirely (isOwner:true), no Stripe call is reachable',
    });

    await check('summary_counts', async () => {
      const [confirmations, proposals, votes] = await Promise.all([
        pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM town.signal_confirmations sc
           JOIN town.signals s ON s.id = sc.signal_id WHERE s.community_id = ANY($1::uuid[])`,
          [poolCommunityIds],
        ),
        pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM town.civic_proposals p
           JOIN town.civic_processes pr ON pr.id = p.process_id WHERE pr.community_id = ANY($1::uuid[])`,
          [poolCommunityIds],
        ),
        pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM town.civic_votes v
           JOIN town.civic_processes pr ON pr.id = v.process_id WHERE pr.community_id = $1`,
          [arenaCommunityId],
        ),
      ]);
      counts.confirmations = Number(confirmations.rows[0]?.count ?? 0);
      counts.proposals = Number(proposals.rows[0]?.count ?? 0);
      counts.votes = Number(votes.rows[0]?.count ?? 0);
      const writesPresent = counts.confirmations > 0 && counts.proposals > 0 && counts.votes > 0;
      return {
        name: 'summary_counts',
        status: writesPresent ? 'ok' : 'fail',
        detail: `confirmations=${String(counts.confirmations)} proposals=${String(counts.proposals)} votes=${String(counts.votes)}`,
      };
    });

    await check('db_connections_and_locks', async () => {
      const [connections, locks] = await Promise.all([
        pool.query<{ count: string }>('SELECT count(*)::text AS count FROM pg_stat_activity'),
        pool.query<{ count: string }>('SELECT count(*)::text AS count FROM pg_locks'),
      ]);
      counts.db_connections = Number(connections.rows[0]?.count ?? 0);
      counts.db_locks = Number(locks.rows[0]?.count ?? 0);
      return {
        name: 'db_connections_and_locks',
        status: 'ok',
        detail: `connections=${String(counts.db_connections)} locks=${String(counts.db_locks)} (snapshot taken after k6 load)`,
      };
    });

    const failed = results.filter((r) => r.status === 'fail');
    return {
      outcome: failed.length === 0 ? 'passed' : 'failed',
      cycle,
      observedAt: new Date().toISOString(),
      checks: results,
      counts,
    };
  }
}

export function runCapacityVerifyCli(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
  collectCapacityVerifyResult(pool)
    .then((result) => {
      process.stdout.write(`${JSON.stringify({ capacityVerifyResult: result })}\n`);
      if (result.outcome === 'failed') {
        process.stderr.write(
          `Capacity drill verification FAILED: ${result.checks
            .filter((check) => check.status === 'fail')
            .map((check) => check.name)
            .join(', ')}\n`,
        );
        process.exitCode = 1;
      } else {
        process.stderr.write('Capacity drill verification PASSED\n');
      }
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? (error.stack ?? error.message) : 'Verification crashed';
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
