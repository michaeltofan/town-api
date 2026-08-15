import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hashSessionToken } from '../ceremony/passkey-authentication/crypto.js';
import { createAccountSession } from '../ceremony/repositories/account-sessions.js';
import { ensureParticipantSignalConfirmation } from '../db/repositories/confirmations.js';
import { runMigrations } from '../db/run-migrations.js';
import { runStagingSeed } from '../db/run-staging-seed.js';
import { createDatabase } from '../db/client.js';
import {
  ADVANCER_COUNT,
  CAPACITY_DRILL_PASSWORD,
  arenaCommunity,
  arenaAccounts,
  arenaSignalIds,
  capacityDrillCycleFromEnv,
  communityA,
  communityB,
  mainAccountsA,
  mainAccountsB,
  mainSignalIdsA,
  mainSignalIdsB,
} from './capacity-drill/fixtures.js';
import {
  deriveCapacityDrillSessionToken,
  requireCapacityDrillAuthSecret,
} from './capacity-drill/session-tokens.js';
import {
  advanceSignalToVoting,
  createLoginAccount,
  createSignal,
  ensureCommunity,
} from './capacity-drill/provisioning.js';

/**
 * One-shot setup for the Etapa 4 capacity drill's dedicated, permanent
 * `capacity` Railway environment: reset once before cycle 1 -> migrate ->
 * seed the deterministic foundation content -> create the capacity-drill
 * fixtures (fixed IDs, see capacity-drill/fixtures.ts). Runs inside
 * town-api-capacity, whose DATABASE_URL points only at the dedicated
 * `capacity` environment's Postgres -- never shared Staging, never
 * production.
 *
 * Prints a single JSON summary line under the unique `capacitySetupResult`
 * key (outcome/checks/counts), read by the orchestrating workflow the same
 * way restore-drill.yml already reads its validator's summary from deploy
 * logs. The key must stay unique: runStagingSeed() prints its own JSON log
 * lines with a top-level `outcome` field, and Railway's deployment log
 * query does not guarantee chronological order, so a generic `outcome` key
 * here previously let the workflow's parser pick up the seed's outcome
 * instead of this script's own final result.
 */

type CheckResult = { name: string; status: 'ok' | 'fail'; detail: string };

const EXPECTED_RAILWAY_ENVIRONMENT_NAME = 'capacity';

/**
 * Drops and recreates the schemas migrations own (`town`, `drizzle`), so
 * cycle 1 starts from a genuinely empty database. Cycle 2 is forbidden from
 * calling this function and appends its separate pool. Refuses unconditionally unless Railway's
 * own `RAILWAY_ENVIRONMENT_NAME` is exactly `capacity` -- this is the one
 * destructive operation in this script, and it must never be reachable
 * against the shared Staging or production Postgres, regardless of what
 * DATABASE_URL happens to be set to.
 */
async function resetCapacitySchema(): Promise<string> {
  const environmentName = process.env.RAILWAY_ENVIRONMENT_NAME;
  if (environmentName !== EXPECTED_RAILWAY_ENVIRONMENT_NAME) {
    throw new Error(
      `Refusing to reset schema: RAILWAY_ENVIRONMENT_NAME is '${environmentName ?? 'unset'}', expected exactly '${EXPECTED_RAILWAY_ENVIRONMENT_NAME}'`,
    );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    await pool.query('DROP SCHEMA IF EXISTS town CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  } finally {
    await pool.end();
  }
  return `schemas town, drizzle dropped in environment '${environmentName}'`;
}

async function runCapacitySetup(): Promise<void> {
  const results: CheckResult[] = [];
  const counts: Record<string, number> = {};

  const check = async (name: string, fn: () => Promise<string>): Promise<void> => {
    try {
      const detail = await fn();
      results.push({ name, status: 'ok', detail });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown error';
      results.push({ name, status: 'fail', detail: message });
      throw error;
    }
  };

  try {
    const cycle = capacityDrillCycleFromEnv();
    const shouldReset = process.env.CAPACITY_DRILL_RESET_SCHEMA !== 'false';
    if (cycle === 2 && shouldReset) {
      throw new Error('Cycle 2 must append its separate fixture pool without resetting the schema');
    }
    if (shouldReset) {
      await check('reset_schema', resetCapacitySchema);
    } else {
      results.push({
        name: 'reset_schema',
        status: 'ok',
        detail: 'skipped for cycle 2; cycle 1 rows remain append-only',
      });
    }

    await check('migrate', async () => {
      await runMigrations();
      return 'migrations applied';
    });

    if (shouldReset) {
      await check('seed_foundation', async () => {
        const result = await runStagingSeed();
        return `outcome=${result.outcome}`;
      });
    } else {
      // Cycle 2 never resets the schema, so cycle 1's foundation content
      // (communities, signals, controlled actor) and its live load-test data
      // (confirmations, proposals, votes) are both still present.
      // runStagingSeed()'s baseline check expects a pristine state
      // (exactly 1 actor, 0 confirmations) and refuses with
      // PREFLIGHT_UNEXPECTED_ROWS/unexpected_rows_prevent_exact_invariants
      // otherwise -- observed directly in run #37 (workflow run
      // 31907358826), where cycle 2's seed_foundation check failed against
      // the thousands of actors and 233 confirmations cycle 1 had already
      // created. Foundation content only ever needs seeding once, before
      // cycle 1; re-running it against cycle 2's already-populated database
      // is both unnecessary and incompatible with how runStagingSeed()
      // validates its baseline.
      results.push({
        name: 'seed_foundation',
        status: 'ok',
        detail: 'skipped for cycle 2; foundation content already seeded in cycle 1',
      });
    }

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required');
    }
    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 5,
      connectionTimeoutMs: 10_000,
      idleTimeoutMs: 2_000,
    });

    try {
      const now = new Date();
      const at = now.toISOString();
      const cycleCommunityA = communityA(cycle);
      const cycleCommunityB = communityB(cycle);
      const cycleArenaCommunity = arenaCommunity(cycle);
      const capacityAuthSecret = requireCapacityDrillAuthSecret({
        environmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
        secret: process.env.CAPACITY_DRILL_AUTH_SECRET,
      });
      const sessionTokenHashKey = process.env.SESSION_TOKEN_HASH_KEY;
      if (!sessionTokenHashKey) {
        throw new Error('SESSION_TOKEN_HASH_KEY is required');
      }

      const provisionSession = async (accountId: string): Promise<void> => {
        const rawToken = deriveCapacityDrillSessionToken({
          secret: capacityAuthSecret,
          accountId,
        });
        await createAccountSession(database.db, {
          id: randomUUID(),
          accountId,
          tokenHash: hashSessionToken({
            hashKey: sessionTokenHashKey,
            clientType: 'mobile',
            token: rawToken,
          }),
          clientType: 'mobile',
          createdAt: at,
          authenticatedAt: at,
        });
      };

      await check('provision_main_pool', async () => {
        const communityA = await ensureCommunity(database.db, {
          id: cycleCommunityA.id,
          slug: cycleCommunityA.slug,
          position: 9000 + cycle * 10 + 1,
          at,
        });
        const communityB = await ensureCommunity(database.db, {
          id: cycleCommunityB.id,
          slug: cycleCommunityB.slug,
          position: 9000 + cycle * 10 + 2,
          at,
        });

        const signalsA = mainSignalIdsA(cycle);
        for (const [i, id] of signalsA.entries()) {
          await createSignal(database.db, {
            id,
            communityId: communityA.id,
            slug: `${cycleCommunityA.slug}-signal-${String(i + 1)}`,
            position: i + 1,
            at,
            index: i,
          });
        }
        const signalsB = mainSignalIdsB(cycle);
        for (const [i, id] of signalsB.entries()) {
          await createSignal(database.db, {
            id,
            communityId: communityB.id,
            slug: `${cycleCommunityB.slug}-signal-${String(i + 1)}`,
            position: i + 1,
            at,
            index: i,
          });
        }

        let created = 0;
        for (const account of mainAccountsA(cycle)) {
          await createLoginAccount(database.db, {
            accountId: account.accountId,
            actorId: account.actorId,
            email: account.email,
            password: CAPACITY_DRILL_PASSWORD,
            communityId: communityA.id,
            community: communityA,
            at,
          });
          await provisionSession(account.accountId);
          created += 1;
        }
        for (const account of mainAccountsB(cycle)) {
          await createLoginAccount(database.db, {
            accountId: account.accountId,
            actorId: account.actorId,
            email: account.email,
            password: CAPACITY_DRILL_PASSWORD,
            communityId: communityB.id,
            community: communityB,
            at,
          });
          await provisionSession(account.accountId);
          created += 1;
        }

        // Leave two signals one confirmation short of the proposals threshold.
        // The real-auth preflight uses the first; the exact synthetic-session
        // preflight uses the second after the final server deployment.
        const preflightSignalIds = signalsA.slice(0, 2);
        if (preflightSignalIds.length !== 2) {
          throw new Error('Capacity preflight signal fixtures are incomplete');
        }
        for (const preflightSignalId of preflightSignalIds) {
          for (const actor of mainAccountsA(cycle).slice(0, ADVANCER_COUNT - 1)) {
            await ensureParticipantSignalConfirmation(
              database.db,
              actor.actorId,
              preflightSignalId,
            );
          }
        }

        counts.main_signals = signalsA.length + signalsB.length;
        counts.main_accounts = created;
        return `communityA=${communityA.id} communityB=${communityB.id} signals=${String(counts.main_signals)} accounts=${String(created)}`;
      });

      await check('provision_voting_arena', async () => {
        const arena = await ensureCommunity(database.db, {
          id: cycleArenaCommunity.id,
          slug: cycleArenaCommunity.slug,
          position: 9900 + cycle,
          at,
        });

        const signalIds = arenaSignalIds(cycle);
        for (const [i, id] of signalIds.entries()) {
          await createSignal(database.db, {
            id,
            communityId: arena.id,
            slug: `${cycleArenaCommunity.slug}-signal-${String(i + 1)}`,
            position: i + 1,
            at,
            index: i,
          });
        }

        const arenaAccountList = arenaAccounts(cycle);
        for (const account of arenaAccountList) {
          await createLoginAccount(database.db, {
            accountId: account.accountId,
            actorId: account.actorId,
            email: account.email,
            password: CAPACITY_DRILL_PASSWORD,
            communityId: arena.id,
            community: arena,
            at,
          });
          await provisionSession(account.accountId);
        }

        const advancerActorIds = arenaAccountList.slice(0, ADVANCER_COUNT).map((a) => a.actorId);
        for (const signalId of signalIds) {
          await advanceSignalToVoting(database.db, { signalId, advancerActorIds, now });
        }

        counts.arena_signals = signalIds.length;
        counts.arena_accounts = arenaAccountList.length;
        counts.synthetic_sessions = (counts.main_accounts ?? 0) + arenaAccountList.length;
        return `arena=${arena.id} signals=${String(signalIds.length)} accounts=${String(arenaAccountList.length)}, all advanced to voting`;
      });
    } finally {
      await database.close();
    }

    const summary = { capacitySetupResult: { outcome: 'passed', checks: results, counts } };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    const failed = results.filter((r) => r.status === 'fail');
    const summary = { capacitySetupResult: { outcome: 'failed', checks: results, counts } };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.stderr.write(`Capacity drill setup FAILED: ${failed.map((f) => f.name).join(', ')}\n`);
    throw error;
  }
}

export function runCapacitySetupCli(): void {
  void (async () => {
    await runCapacitySetup();
    if (process.env.CAPACITY_DRILL_SERVE_AFTER_SETUP === 'true') {
      await import('../server.js');
    }
  })().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : 'Setup failed';
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
