import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { requireDatabaseUrl, requireStagingEnv } from './lib/env.js';

/**
 * Etapa 4 post-run integrity verification -- STAGING ONLY, read-only.
 *
 * The spec's closing bar is "zero voturi sau plăți duplicate, zero scrieri
 * pierdute și zero acces cross-community." Every one of those invariants is
 * already enforced by a DB-level UNIQUE constraint or an application-level
 * gate (see civic_ballot_tokens_process_actor_cycle_unique,
 * civic_proposals_process_actor_unique,
 * signal_confirmations_signal_actor_unique, and evaluateCivicAccess's
 * community-match check) -- this script's job is not to discover a new
 * mechanism, it's to produce evidence that those mechanisms actually held
 * under the concurrent load k6 just generated, by querying the rows they
 * produced rather than trusting the constraints exist.
 *
 * Never writes. Connects only to the DATABASE_URL it's given. Scopes every
 * query to the load-test communities named in the two manifests (the
 * ephemeral pool from provision.ts and the permanent voting arena from
 * ensure-voting-arena.ts) -- never scans or reports on unrelated staging
 * activity.
 */

type ManifestAccount = { communityId: string };
type Manifest = {
  communityA: { id: string };
  communityB: { id: string };
  accounts: ManifestAccount[];
};
type ArenaManifest = {
  community: { id: string };
};

type CheckResult = {
  name: string;
  status: 'ok' | 'fail';
  detail: string;
};

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

function readArenaManifest(path: string): ArenaManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as ArenaManifest;
}

async function runVerify(): Promise<void> {
  requireStagingEnv(process.env);
  const databaseUrl = requireDatabaseUrl(process.env);
  const manifestPath = process.env.LOADTEST_MANIFEST_PATH ?? 'loadtest/.manifest.json';
  const arenaManifestPath =
    process.env.LOADTEST_VOTING_ARENA_MANIFEST_PATH ?? 'loadtest/.voting-arena-manifest.json';

  const manifest = readManifest(manifestPath);
  const arenaManifest = readArenaManifest(arenaManifestPath);
  const poolCommunityIds = [manifest.communityA.id, manifest.communityB.id];
  const arenaCommunityId = arenaManifest.community.id;
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
    // --- Scope sanity: the manifests actually name rows that exist. ---
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
            detail: `only ${String(found)}/3 load-test communities found`,
          };
    });

    // --- Zero duplicate confirmations (ephemeral pool). ---
    // signal_confirmations_signal_actor_unique already enforces this at the
    // DB level; this proves it actually held under concurrent k6 traffic.
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

    // --- Zero cross-community confirmations (ephemeral pool + arena). ---
    // evaluateCivicAccess denies this at request time; this proves no
    // confirmation row exists where the confirming actor's community
    // disagrees with the signal's community, for every load-test community.
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

    // --- Zero duplicate proposals per actor per process (ephemeral pool). ---
    // civic_proposals_process_actor_unique already enforces this.
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

    // --- Zero cross-community proposals (ephemeral pool). ---
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

    // --- Zero actors minted more than one ballot token for the same cycle
    // (arena). civic_ballot_tokens_process_actor_cycle_unique enforces this.
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

    // --- Zero cross-community ballot-token eligibility (arena). ---
    await countCheck(
      'no_cross_community_ballot_tokens',
      'cross-community ballot token rows',
      `SELECT count(*)::text AS count FROM town.civic_ballot_tokens t
       JOIN town.actors a ON a.id = t.actor_id
       JOIN town.civic_processes pr ON pr.id = t.process_id
       WHERE pr.community_id = $1 AND a.community_id IS DISTINCT FROM pr.community_id`,
      [arenaCommunityId],
    );

    // --- Zero duplicate/lost votes: this is the load test's central claim.
    // civic_votes carries no actor_id (secret ballot, §9) so "did actor X
    // vote twice" cannot be asked of the vote rows directly -- it has to be
    // asked of the token table that gates them. castCivicVote() consumes a
    // token and inserts a vote in the same atomic statement, so for every
    // arena process the number of *consumed* tokens must equal the number
    // of vote rows exactly: more consumed tokens than votes would mean a
    // token was consumed without a vote being recorded (a lost write);
    // fewer would mean a vote exists without a consumed token (impossible
    // under the FK, but checked anyway as direct evidence, not an inference
    // from the constraint's existence).
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

    // --- Zero duplicate/real payments: N/A by construction, not skipped
    // silently -- every load-test account is isOwner:true, which bypasses
    // the membership/payment entitlement gate entirely (see
    // loadtest/lib/provisioning.ts), so no Stripe checkout or membership
    // purchase flow is ever reachable from this test. Recorded here so the
    // report doesn't read as an omission.
    results.push({
      name: 'no_duplicate_payments',
      status: 'ok',
      detail:
        'N/A: load-test accounts bypass the payment gate entirely (isOwner:true), no Stripe call is reachable',
    });

    // --- Summary counts for the report. ---
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
        `Etapa 4 integrity verification FAILED: ${failed.map((f) => f.name).join(', ')}\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write('Etapa 4 integrity verification PASSED\n');
  } finally {
    await pool.end();
  }
}

runVerify().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : 'Verification crashed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
