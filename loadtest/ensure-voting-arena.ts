import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createDatabase } from '../src/db/client.js';
import { findCivicProcessBySignalId } from '../src/db/repositories/civic-processes.js';
import { findPublishedSignalById } from '../src/db/repositories/signals.js';
import { findAccountById } from '../src/identity/repositories/accounts.js';
import { LOADTEST_VOTING_ARENA_COMMUNITY_ID } from '../src/db/seeds/loadtest-voting-arena.js';
import { requireDatabaseUrl, requireStagingEnv } from './lib/env.js';
import {
  advanceSignalToVoting,
  createLoginAccount,
  createSignal,
  ensureCommunity,
  resetAccountPassword,
} from './lib/provisioning.js';

/**
 * Etapa 4 load-test permanent voting-arena fixture -- STAGING ONLY.
 *
 * `civic_ballot_eligible_actors` is append-only (see
 * `src/db/seeds/loadtest-voting-arena.ts` for the full rationale), so a
 * signal that reaches 'voting' can never be deleted again -- incompatible
 * with `loadtest/provision.ts`'s fully-torn-down-every-run ephemeral pool.
 * This script instead maintains a small, fixed-identity fixture that is
 * created once and never deleted: one community, a handful of signals
 * already sitting in 'voting', and a pool of voter accounts. The k6 "vot"
 * scenario points at this fixture instead of the ephemeral pool.
 *
 * Idempotent and safe to run before every load-test invocation:
 * - If the community/signals/accounts already exist, nothing is
 *   recreated -- only account passwords are rotated (the plaintext from a
 *   prior run can't be recovered, only the hash is stored) and a fresh
 *   manifest is written.
 * - If a signal's process hasn't reached 'voting' yet, it's advanced.
 * - `run-staging-seed.ts`'s row-count preflight guard excludes rows scoped
 *   to `LOADTEST_VOTING_ARENA_COMMUNITY_ID`, so this fixture's permanent
 *   presence never blocks a future foundation-content reseed.
 *
 * Output: writes a manifest JSON file (path from
 * LOADTEST_VOTING_ARENA_MANIFEST_PATH, default
 * loadtest/.voting-arena-manifest.json) that the k6 script's voting
 * scenario consumes. Never deletes anything -- there is no teardown for
 * this fixture.
 */

const SIGNAL_COUNT = 8;
const VOTER_COUNT = 40;
const ADVANCER_COUNT = 5; // distinct actors needed to cross each stage threshold

function fixedId(group: string, index: number): string {
  return `00000000-0000-4000-${group}-${index.toString().padStart(12, '0')}`;
}

type ManifestAccount = {
  accountId: string;
  actorId: string;
  email: string;
  password: string;
  communityId: string;
};

type Manifest = {
  updatedAt: string;
  community: { id: string; slug: string };
  signals: string[]; // all already at 'voting'
  accounts: ManifestAccount[];
};

async function main(): Promise<void> {
  requireStagingEnv(process.env);
  const databaseUrl = requireDatabaseUrl(process.env);
  const manifestPath =
    process.env.LOADTEST_VOTING_ARENA_MANIFEST_PATH ?? 'loadtest/.voting-arena-manifest.json';

  const database = createDatabase({
    connectionString: databaseUrl,
    poolMax: 5,
    connectionTimeoutMs: 10_000,
    idleTimeoutMs: 2_000,
  });

  try {
    const now = new Date();
    const at = now.toISOString();

    const community = await ensureCommunity(database.db, {
      id: LOADTEST_VOTING_ARENA_COMMUNITY_ID,
      slug: 'loadtest-voting-arena',
      position: 9999,
      at,
    });
    process.stdout.write(`Voting arena community: ${community.id}\n`);

    const signalIds: string[] = [];
    for (let i = 0; i < SIGNAL_COUNT; i += 1) {
      const id = fixedId('9001', i + 1);
      const existing = await findPublishedSignalById(database.db, id);
      if (!existing) {
        await createSignal(database.db, {
          id,
          communityId: community.id,
          slug: `loadtest-voting-arena-signal-${String(i + 1)}`,
          position: i + 1,
          at,
          index: i,
        });
        process.stdout.write(`Created voting-arena signal ${id}\n`);
      }
      signalIds.push(id);
    }

    const accountsManifest: ManifestAccount[] = [];
    for (let i = 0; i < VOTER_COUNT; i += 1) {
      const accountId = fixedId('9002', i + 1);
      const actorId = fixedId('9003', i + 1);
      const email = `loadtest-arena+${String(i + 1)}@loadtest.town.internal`;
      const password = `LoadTestArena-${randomBytes(9).toString('hex')}!`;

      const existing = await findAccountById(database.db, accountId);
      if (existing) {
        await resetAccountPassword(database.db, { accountId, password, at });
      } else {
        await createLoginAccount(database.db, {
          accountId,
          actorId,
          email,
          password,
          communityId: community.id,
          community,
          at,
        });
      }
      accountsManifest.push({ accountId, actorId, email, password, communityId: community.id });
    }
    process.stdout.write(`Voting-arena accounts ready: ${String(accountsManifest.length)}\n`);

    const advancerActorIds = accountsManifest.slice(0, ADVANCER_COUNT).map((a) => a.actorId);
    if (advancerActorIds.length < ADVANCER_COUNT) {
      throw new Error('Not enough voting-arena accounts to advance signals');
    }

    for (const [i, signalId] of signalIds.entries()) {
      const process_ = await findCivicProcessBySignalId(database.db, signalId);
      if (!process_) {
        throw new Error(`No civic process provisioned for voting-arena signal ${signalId}`);
      }
      if (process_.currentStage === 'voting') {
        process.stdout.write(
          `Voting-arena signal ${String(i + 1)}/${String(signalIds.length)} already at voting: ${signalId}\n`,
        );
        continue;
      }
      await advanceSignalToVoting(database.db, { signalId, advancerActorIds, now });
      process.stdout.write(
        `Advanced voting-arena signal ${String(i + 1)}/${String(signalIds.length)} to voting: ${signalId}\n`,
      );
    }

    const manifest: Manifest = {
      updatedAt: at,
      community: { id: community.id, slug: community.slug },
      signals: signalIds,
      accounts: accountsManifest,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    process.stdout.write(`Manifest written to ${manifestPath}\n`);
    process.stdout.write('VOTING_ARENA_OK\n');
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : 'Voting-arena setup failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
