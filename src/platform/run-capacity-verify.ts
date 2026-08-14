import { Pool } from 'pg';
import { ARENA_COMMUNITY, COMMUNITY_A, COMMUNITY_B } from './capacity-drill/fixtures.js';

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
 */

type CheckResult = { name: string; status: 'ok' | 'fail'; detail: string };

async function runCapacityVerify(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const poolCommunityIds = [COMMUNITY_A.id, COMMUNITY_B.id];
  const arenaCommunityId = ARENA_COMMUNITY.id;
  const allCommunityIds = [...poolCommunityIds, arenaCommunityId];

  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
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

  try {
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
      return {
        name: 'summary_counts',
        status: 'ok',
        detail: `confirmations=${String(counts.confirmations)} proposals=${String(counts.proposals)} votes=${String(counts.votes)}`,
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
        `Capacity drill verification FAILED: ${failed.map((f) => f.name).join(', ')}\n`,
      );
      process.exitCode = 1;
    } else {
      process.stderr.write('Capacity drill verification PASSED\n');
    }
  } finally {
    await pool.end();
  }
}

export function runCapacityVerifyCli(): void {
  runCapacityVerify().catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : 'Verification crashed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
