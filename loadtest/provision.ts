import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createDatabase } from '../src/db/client.js';
import { requireDatabaseUrl, requireStagingEnv } from './lib/env.js';
import { createLoginAccount, createSignal, ensureCommunity } from './lib/provisioning.js';

/**
 * Etapa 4 load-test data provisioning -- STAGING ONLY.
 *
 * Builds a fully isolated, ephemeral dataset (two dedicated communities, a
 * set of dedicated signals, and a pool of real login-capable accounts) so
 * the k6 capacity scenario can exercise real writes (confirm, propose) --
 * everything this script creates is deleted by `loadtest/teardown.ts` at
 * the end of the run, restoring staging to byte-identical canonical state.
 *
 * This pool never advances any signal past 'proposals'/'deliberation':
 * `civic_ballot_eligible_actors` (minted once a process reaches
 * 'ballot_preparation') is append-only and RESTRICT-cascades undeletability
 * up through actors/processes/signals/communities (see
 * `src/db/seeds/loadtest-voting-arena.ts`), which is incompatible with a
 * pool that must be fully torn down every run. The "vot" scenario instead
 * uses the small permanent fixture created by
 * `loadtest/ensure-voting-arena.ts`.
 *
 * All accounts are created with `isOwner: true` (matching the pattern in
 * `scripts/bootstrap-platform-owner.ts`), which bypasses the membership/
 * payment entitlement gate in `evaluateCivicAccess` -- so no Stripe
 * checkout, no real money, and no membership purchase flow is ever
 * exercised, while accounts are still fully real, participant-level civic
 * actors subject to every other authorization check (actor/account match,
 * community match, community-commitment validity).
 *
 * Output: writes a manifest JSON file (path from LOADTEST_MANIFEST_PATH,
 * default loadtest/.manifest.json) that teardown.ts and the k6 script both
 * consume. Never deletes anything itself -- provisioning only adds.
 */

const VU_POOL_SIZE = Number(process.env.LOADTEST_VU_POOL_SIZE ?? '250');
const COMMUNITY_B_SHARE = 0.1; // ~10% of the pool lands in the "wrong" community, for cross-community negative testing
const TARGET_SIGNALS_MAIN = 20;
const TARGET_SIGNALS_SECONDARY = 3;

type ManifestAccount = {
  accountId: string;
  actorId: string;
  email: string;
  password: string;
  communityId: string;
};

type Manifest = {
  createdAt: string;
  runTag: string;
  communityA: { id: string; slug: string };
  communityB: { id: string; slug: string };
  signalsMain: string[]; // community A, fresh 'confirmation' stage
  signalsSecondary: string[]; // community B, fresh
  accounts: ManifestAccount[];
};

async function main(): Promise<void> {
  requireStagingEnv(process.env);
  const databaseUrl = requireDatabaseUrl(process.env);
  const runTag = process.env.LOADTEST_RUN_TAG ?? randomUUID().slice(0, 8);
  const manifestPath = process.env.LOADTEST_MANIFEST_PATH ?? 'loadtest/.manifest.json';

  const database = createDatabase({
    connectionString: databaseUrl,
    poolMax: 5,
    connectionTimeoutMs: 10_000,
    idleTimeoutMs: 2_000,
  });

  try {
    const now = new Date();
    const at = now.toISOString();

    const communityA = await ensureCommunity(database.db, {
      id: randomUUID(),
      slug: `loadtest-arena-a-${runTag}`,
      position: 9001,
      at,
    });
    const communityB = await ensureCommunity(database.db, {
      id: randomUUID(),
      slug: `loadtest-arena-b-${runTag}`,
      position: 9002,
      at,
    });

    process.stdout.write(`Created communities: A=${communityA.id} B=${communityB.id}\n`);

    const signalsMain: string[] = [];
    for (let i = 0; i < TARGET_SIGNALS_MAIN; i += 1) {
      signalsMain.push(
        await createSignal(database.db, {
          communityId: communityA.id,
          slug: `loadtest-signal-a-${runTag}-${String(i)}`,
          position: i + 1,
          at,
          index: i,
        }),
      );
    }
    const signalsSecondary: string[] = [];
    for (let i = 0; i < TARGET_SIGNALS_SECONDARY; i += 1) {
      signalsSecondary.push(
        await createSignal(database.db, {
          communityId: communityB.id,
          slug: `loadtest-signal-b-${runTag}-${String(i)}`,
          position: i + 1,
          at,
          index: i,
        }),
      );
    }
    process.stdout.write(
      `Created ${String(signalsMain.length)} signals in A, ${String(signalsSecondary.length)} in B\n`,
    );

    const bCount = Math.max(1, Math.round(VU_POOL_SIZE * COMMUNITY_B_SHARE));
    const aCount = VU_POOL_SIZE - bCount;
    const accountsManifest: ManifestAccount[] = [];

    for (let i = 0; i < aCount; i += 1) {
      const email = `loadtest+${runTag}-a-${String(i)}@loadtest.town.internal`;
      const password = `LoadTest-${runTag}-${randomBytes(9).toString('hex')}!`;
      const { accountId, actorId } = await createLoginAccount(database.db, {
        email,
        password,
        communityId: communityA.id,
        community: communityA,
        at,
      });
      accountsManifest.push({ accountId, actorId, email, password, communityId: communityA.id });
      if ((i + 1) % 25 === 0) {
        process.stdout.write(
          `Provisioned ${String(i + 1)}/${String(aCount)} community-A accounts\n`,
        );
      }
    }
    for (let i = 0; i < bCount; i += 1) {
      const email = `loadtest+${runTag}-b-${String(i)}@loadtest.town.internal`;
      const password = `LoadTest-${runTag}-${randomBytes(9).toString('hex')}!`;
      const { accountId, actorId } = await createLoginAccount(database.db, {
        email,
        password,
        communityId: communityB.id,
        community: communityB,
        at,
      });
      accountsManifest.push({ accountId, actorId, email, password, communityId: communityB.id });
    }
    process.stdout.write(`Provisioned ${String(accountsManifest.length)} total accounts\n`);

    const manifest: Manifest = {
      createdAt: at,
      runTag,
      communityA: { id: communityA.id, slug: communityA.slug },
      communityB: { id: communityB.id, slug: communityB.slug },
      signalsMain,
      signalsSecondary,
      accounts: accountsManifest,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    process.stdout.write(`Manifest written to ${manifestPath}\n`);
    process.stdout.write('PROVISION_OK\n');
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : 'Provisioning failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
