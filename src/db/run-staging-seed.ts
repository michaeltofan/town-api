import { count, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { toIsoTimestamp } from '../lib/timestamps.js';
import * as schema from './schema.js';
import { actors, communities, signalConfirmations, signals } from './schema.js';
import {
  CONTROLLED_TEST_ACTOR,
  CONTROLLED_TEST_ACTOR_ID,
} from './seeds/controlled-actor-content.js';
import {
  FOUNDATION_COMMUNITIES,
  FOUNDATION_SIGNAL_IDS,
  FOUNDATION_SIGNALS,
  type CanonicalCommunity,
  type CanonicalSignal,
} from './seeds/foundation-content.js';
import { LOADTEST_VOTING_ARENA_COMMUNITY_ID } from './seeds/loadtest-voting-arena.js';
import { seedControlledActor } from './seeds/seed-controlled-actor.js';
import { seedFoundationContent } from './seeds/seed-foundation.js';

/**
 * Stable advisory-lock identity for the staging seed runner.
 * Distinct from the migration lock (`town-api-migrate`).
 */
const ADVISORY_LOCK_KEY = "hashtext('town-api-staging-seed')";

const EXPECTED_COMMUNITY_COUNT = FOUNDATION_COMMUNITIES.length;
const EXPECTED_SIGNAL_COUNT = FOUNDATION_SIGNALS.length;
const CANONICAL_COMMUNITY_IDS = FOUNDATION_COMMUNITIES.map((row) => row.id);
const CANONICAL_SIGNAL_IDS = FOUNDATION_SIGNALS.map((row) => row.id);

type Db = NodePgDatabase<typeof schema>;

export type StagingSeedErrorCode =
  | 'APP_ENV_NOT_STAGING'
  | 'DATABASE_URL_REQUIRED'
  | 'LOCK_HELD'
  | 'PREFLIGHT_CONFIRMATIONS_PRESENT'
  | 'PREFLIGHT_CONTROLLED_ACTOR_LINKED'
  | 'PREFLIGHT_PARTIAL_CANONICAL'
  | 'PREFLIGHT_CONFLICTING_CANONICAL'
  | 'PREFLIGHT_UNEXPECTED_ROWS'
  | 'POSTCHECK_INVARIANT_FAILED'
  | 'INJECTED_FAILURE';

export class StagingSeedError extends Error {
  readonly code: StagingSeedErrorCode;

  constructor(code: StagingSeedErrorCode, message: string) {
    super(message);
    this.name = 'StagingSeedError';
    this.code = code;
  }
}

export type StagingSeedOutcome = 'seeded' | 'already_canonical' | 'reconciled' | 'completed_subset';

export type StagingSeedResult = {
  readonly outcome: StagingSeedOutcome;
  readonly counts: {
    readonly communities: number;
    readonly signals: number;
    readonly actors: number;
    readonly controlledActors: number;
    readonly confirmations: number;
  };
};

export type RunStagingSeedOptions = {
  readonly env?: NodeJS.ProcessEnv;
  /** Test-only: throw after mutation inside the transaction to prove rollback. */
  readonly injectFailureAfterMutation?: boolean;
};

type BaselineKind = 'empty' | 'exact' | 'content_drift' | 'canonical_subset' | 'refuse';

type BaselineAssessment = {
  readonly kind: BaselineKind;
  readonly refuseCode?: StagingSeedErrorCode;
  readonly refuseReason?: string;
  readonly counts: StagingSeedResult['counts'];
};

type LogStage =
  'env_check' | 'lock_acquire' | 'preflight' | 'mutate' | 'postcheck' | 'complete' | 'error';

function logEvent(
  stage: LogStage,
  status: 'ok' | 'fail' | 'skip',
  details: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const payload: Record<string, string | number | boolean | null> = {
    operation: 'db:seed:staging:production',
    stage,
    status,
  };
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined) {
      payload[key] = value;
    }
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function requireStagingEnv(env: NodeJS.ProcessEnv): string {
  const appEnv = env.APP_ENV;
  if (appEnv !== 'staging') {
    throw new StagingSeedError(
      'APP_ENV_NOT_STAGING',
      'Staging seed runner requires APP_ENV=staging and refuses all other environments',
    );
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new StagingSeedError(
      'DATABASE_URL_REQUIRED',
      'DATABASE_URL is required for db:seed:staging:production',
    );
  }
  return databaseUrl;
}

function normalizeCommunity(row: typeof communities.$inferSelect): CanonicalCommunity {
  return {
    id: row.id,
    slug: row.slug,
    position: row.position,
    countryCode: row.countryCode,
    cityName: row.cityName,
    displayName: row.displayName,
    defaultLocale: row.defaultLocale,
    timezone: row.timezone,
    status: 'active',
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

function normalizeSignal(row: typeof signals.$inferSelect): CanonicalSignal {
  return {
    id: row.id,
    communityId: row.communityId,
    slug: row.slug,
    position: row.position,
    locale: row.locale,
    category: row.category,
    area: row.area,
    headline: row.headline,
    summary: row.summary,
    description: row.description,
    whyItMatters: row.whyItMatters,
    whoIsAffected: row.whoIsAffected,
    latestUpdate: row.latestUpdate,
    statusLabel: row.statusLabel,
    statusNote: row.statusNote,
    observedLabel: row.observedLabel,
    observedOn: row.observedOn,
    observedPrecision: row.observedPrecision as 'day' | 'week',
    authorDisplayName: row.authorDisplayName,
    imageKey: row.imageKey,
    imageFocusX: row.imageFocusX,
    imageFocusY: row.imageFocusY,
    publicationStatus: 'published',
    publishedAt: toIsoTimestamp(row.publishedAt),
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

/**
 * Rows scoped to `LOADTEST_VOTING_ARENA_COMMUNITY_ID` are a deliberately
 * permanent fixture (see `./seeds/loadtest-voting-arena.ts`) maintained by
 * `loadtest/ensure-voting-arena.ts`, not canonical foundation content or
 * incidental drift -- excluded here so their permanent presence never trips
 * this preflight guard.
 */
async function readCounts(db: Db): Promise<StagingSeedResult['counts']> {
  // Sequential queries avoid pg driver deprecation for concurrent query on one client.
  const communityCount = await db
    .select({ value: count() })
    .from(communities)
    .where(ne(communities.id, LOADTEST_VOTING_ARENA_COMMUNITY_ID));
  const signalCount = await db
    .select({ value: count() })
    .from(signals)
    .where(ne(signals.communityId, LOADTEST_VOTING_ARENA_COMMUNITY_ID));
  const actorCount = await db
    .select({ value: count() })
    .from(actors)
    // communityId is nullable (actors created before community commitment);
    // ne() against NULL never matches, so it has to be OR'd with isNull()
    // to avoid silently excluding every not-yet-committed actor.
    .where(
      or(isNull(actors.communityId), ne(actors.communityId, LOADTEST_VOTING_ARENA_COMMUNITY_ID)),
    );
  const controlledCount = await db
    .select({ value: count() })
    .from(actors)
    .where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID));
  const confirmationCount = await db
    .select({ value: count() })
    .from(signalConfirmations)
    .innerJoin(actors, eq(actors.id, signalConfirmations.actorId))
    .where(ne(actors.communityId, LOADTEST_VOTING_ARENA_COMMUNITY_ID));

  return {
    communities: communityCount[0]?.value ?? 0,
    signals: signalCount[0]?.value ?? 0,
    actors: actorCount[0]?.value ?? 0,
    controlledActors: controlledCount[0]?.value ?? 0,
    confirmations: confirmationCount[0]?.value ?? 0,
  };
}

async function communitiesMatchCanonical(db: Db): Promise<boolean> {
  const rows = await db
    .select()
    .from(communities)
    .where(inArray(communities.id, [...CANONICAL_COMMUNITY_IDS]));
  if (rows.length !== EXPECTED_COMMUNITY_COUNT) {
    return false;
  }
  const byId = new Map(rows.map((row) => [row.id, normalizeCommunity(row)]));
  for (const expected of FOUNDATION_COMMUNITIES) {
    const actual = byId.get(expected.id);
    if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
      return false;
    }
  }
  return true;
}

async function signalsMatchCanonical(db: Db): Promise<boolean> {
  const rows = await db
    .select()
    .from(signals)
    .where(inArray(signals.id, [...CANONICAL_SIGNAL_IDS]));
  if (rows.length !== EXPECTED_SIGNAL_COUNT) {
    return false;
  }
  const byId = new Map(rows.map((row) => [row.id, normalizeSignal(row)]));
  for (const expected of FOUNDATION_SIGNALS) {
    const actual = byId.get(expected.id);
    if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
      return false;
    }
  }
  return true;
}

async function controlledActorMatchesCanonical(db: Db): Promise<boolean> {
  const rows = await db.select().from(actors).where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID));
  const row = rows[0];
  if (!row) {
    return false;
  }
  return (
    row.kind === CONTROLLED_TEST_ACTOR.kind &&
    row.status === CONTROLLED_TEST_ACTOR.status &&
    row.displayLabel === CONTROLLED_TEST_ACTOR.displayLabel &&
    row.communityId === CONTROLLED_TEST_ACTOR.communityId &&
    row.accountId === null &&
    toIsoTimestamp(row.createdAt) === CONTROLLED_TEST_ACTOR.createdAt &&
    toIsoTimestamp(row.updatedAt) === CONTROLLED_TEST_ACTOR.updatedAt
  );
}

/**
 * True when every canonical foundation / controlled-actor ID is present and the
 * controlled actor remains unlinked. Used to permit text-only content reconcile
 * without deleting rows or accepting non-canonical identity sets.
 */
async function canonicalIdentityPresent(db: Db): Promise<boolean> {
  const communityRows = await db
    .select({ id: communities.id })
    .from(communities)
    .where(inArray(communities.id, [...CANONICAL_COMMUNITY_IDS]));
  if (communityRows.length !== EXPECTED_COMMUNITY_COUNT) {
    return false;
  }
  const signalRows = await db
    .select({ id: signals.id })
    .from(signals)
    .where(inArray(signals.id, [...CANONICAL_SIGNAL_IDS]));
  if (signalRows.length !== EXPECTED_SIGNAL_COUNT) {
    return false;
  }
  const controlledRows = await db
    .select()
    .from(actors)
    .where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID));
  const controlled = controlledRows[0];
  return controlled?.accountId === null;
}

/**
 * True when the DB holds a strict subset of the current manifest: every present
 * community/signal matches its manifest row exactly (full-JSON compare), there
 * are no non-canonical extras, the controlled actor matches, and the manifest
 * still has communities and/or signals not yet inserted.
 */
async function presentRowsExactCanonicalSubset(db: Db): Promise<boolean> {
  const communityRows = await db
    .select()
    .from(communities)
    .where(ne(communities.id, LOADTEST_VOTING_ARENA_COMMUNITY_ID));
  const signalRows = await db
    .select()
    .from(signals)
    .where(ne(signals.communityId, LOADTEST_VOTING_ARENA_COMMUNITY_ID));

  if (communityRows.length === 0 && signalRows.length === 0) {
    return false;
  }
  if (
    communityRows.length > EXPECTED_COMMUNITY_COUNT ||
    signalRows.length > EXPECTED_SIGNAL_COUNT
  ) {
    return false;
  }
  if (
    communityRows.length === EXPECTED_COMMUNITY_COUNT &&
    signalRows.length === EXPECTED_SIGNAL_COUNT
  ) {
    return false;
  }

  const expectedCommunityById = new Map<string, CanonicalCommunity>(
    FOUNDATION_COMMUNITIES.map((row) => [row.id, row]),
  );
  const expectedSignalById = new Map<string, CanonicalSignal>(
    FOUNDATION_SIGNALS.map((row) => [row.id, row]),
  );

  for (const row of communityRows) {
    const expected = expectedCommunityById.get(row.id);
    if (!expected) {
      return false;
    }
    if (JSON.stringify(normalizeCommunity(row)) !== JSON.stringify(expected)) {
      return false;
    }
  }
  for (const row of signalRows) {
    const expected = expectedSignalById.get(row.id);
    if (!expected) {
      return false;
    }
    if (JSON.stringify(normalizeSignal(row)) !== JSON.stringify(expected)) {
      return false;
    }
  }

  const presentCommunityIds = new Set(communityRows.map((row) => row.id));
  const presentSignalIds = new Set(signalRows.map((row) => row.id));
  const missingFromManifest =
    FOUNDATION_COMMUNITIES.some((row) => !presentCommunityIds.has(row.id)) ||
    FOUNDATION_SIGNALS.some((row) => !presentSignalIds.has(row.id));
  if (!missingFromManifest) {
    return false;
  }

  return await controlledActorMatchesCanonical(db);
}

async function assessBaseline(db: Db): Promise<BaselineAssessment> {
  const counts = await readCounts(db);

  const controlledRows = await db
    .select()
    .from(actors)
    .where(eq(actors.id, CONTROLLED_TEST_ACTOR_ID));
  if (controlledRows[0]?.accountId !== null && controlledRows[0]?.accountId !== undefined) {
    return {
      kind: 'refuse',
      refuseCode: 'PREFLIGHT_CONTROLLED_ACTOR_LINKED',
      refuseReason: 'controlled_actor_account_id_must_be_null',
      counts,
    };
  }

  const empty =
    counts.communities === 0 &&
    counts.signals === 0 &&
    counts.actors === 0 &&
    counts.controlledActors === 0 &&
    counts.confirmations === 0;
  if (empty) {
    return { kind: 'empty', counts };
  }

  const exactTotals =
    counts.communities === EXPECTED_COMMUNITY_COUNT &&
    counts.signals === EXPECTED_SIGNAL_COUNT &&
    counts.actors === 1 &&
    counts.controlledActors === 1 &&
    counts.confirmations === 0;

  if (exactTotals) {
    const communitiesOk = await communitiesMatchCanonical(db);
    const signalsOk = await signalsMatchCanonical(db);
    const actorOk = await controlledActorMatchesCanonical(db);
    if (communitiesOk && signalsOk && actorOk) {
      return { kind: 'exact', counts };
    }
    // Same identity set, drifted text/metadata → reconcile via upsert (never delete).
    if (await canonicalIdentityPresent(db)) {
      return { kind: 'content_drift', counts };
    }
    return {
      kind: 'refuse',
      refuseCode: 'PREFLIGHT_CONFLICTING_CANONICAL',
      refuseReason: 'canonical_rows_do_not_match_manifest',
      counts,
    };
  }

  // Communities/signals row counts beyond the manifest size always indicate
  // corruption, regardless of unrelated actor/confirmation activity.
  if (counts.communities > EXPECTED_COMMUNITY_COUNT || counts.signals > EXPECTED_SIGNAL_COUNT) {
    return {
      kind: 'refuse',
      refuseCode: 'PREFLIGHT_UNEXPECTED_ROWS',
      refuseReason: 'unexpected_rows_prevent_exact_invariants',
      counts,
    };
  }

  // Growing-catalog completion: every present canonical community/signal row
  // matches the manifest exactly and the manifest has entries not yet
  // present. seedFoundationContent/seedControlledActor only ever insert new
  // canonical rows or upsert-in-place existing canonical rows by fixed ID —
  // they never read or mutate any actor row besides the single controlled
  // test actor, and never touch signal_confirmations at all. Organic activity
  // accumulated on staging (real actors, real confirmations) is therefore
  // provably safe to leave untouched and must not block adding new
  // communities/signals to the catalog.
  if (await presentRowsExactCanonicalSubset(db)) {
    return { kind: 'canonical_subset', counts };
  }

  if (counts.confirmations > 0) {
    return {
      kind: 'refuse',
      refuseCode: 'PREFLIGHT_CONFIRMATIONS_PRESENT',
      refuseReason: 'signal_confirmations_must_be_zero',
      counts,
    };
  }

  if (counts.actors > 1) {
    return {
      kind: 'refuse',
      refuseCode: 'PREFLIGHT_UNEXPECTED_ROWS',
      refuseReason: 'unexpected_rows_prevent_exact_invariants',
      counts,
    };
  }

  // Unexpected extras or incomplete subsets — never truncate/repair.
  const hasAnyCanonicalCommunity = await db
    .select({ value: count() })
    .from(communities)
    .where(inArray(communities.id, [...CANONICAL_COMMUNITY_IDS]));
  const hasAnyCanonicalSignal = await db
    .select({ value: count() })
    .from(signals)
    .where(inArray(signals.id, [...CANONICAL_SIGNAL_IDS]));
  const canonicalCommunityPresent = (hasAnyCanonicalCommunity[0]?.value ?? 0) > 0;
  const canonicalSignalPresent = (hasAnyCanonicalSignal[0]?.value ?? 0) > 0;
  const controlledPresent = counts.controlledActors > 0;

  if (canonicalCommunityPresent || canonicalSignalPresent || controlledPresent) {
    return {
      kind: 'refuse',
      refuseCode: 'PREFLIGHT_PARTIAL_CANONICAL',
      refuseReason: 'partial_canonical_baseline',
      counts,
    };
  }

  return {
    kind: 'refuse',
    refuseCode: 'PREFLIGHT_UNEXPECTED_ROWS',
    refuseReason: 'non_canonical_rows_present',
    counts,
  };
}

async function assertPostInvariants(
  db: Db,
  baselineCounts: StagingSeedResult['counts'],
): Promise<StagingSeedResult['counts']> {
  const counts = await readCounts(db);
  const communitiesOk = await communitiesMatchCanonical(db);
  const signalsOk = await signalsMatchCanonical(db);
  const actorOk = await controlledActorMatchesCanonical(db);

  const signalsByCommunityId = new Map<string, (typeof signals.$inferSelect)[]>();
  for (const community of FOUNDATION_COMMUNITIES) {
    const communitySignals = await db
      .select()
      .from(signals)
      .where(eq(signals.communityId, community.id));
    signalsByCommunityId.set(community.id, communitySignals);
  }

  const expectedSignalsByCommunityId = new Map<string, CanonicalSignal[]>();
  for (const signal of FOUNDATION_SIGNALS) {
    const bucket = expectedSignalsByCommunityId.get(signal.communityId) ?? [];
    bucket.push(signal);
    expectedSignalsByCommunityId.set(signal.communityId, bucket);
  }

  let orderingOk = true;
  for (const community of FOUNDATION_COMMUNITIES) {
    const expectedForCommunity = expectedSignalsByCommunityId.get(community.id) ?? [];
    const actualForCommunity = signalsByCommunityId.get(community.id) ?? [];
    if (actualForCommunity.length !== expectedForCommunity.length) {
      orderingOk = false;
      break;
    }
    const sorted = [...actualForCommunity].sort((a, b) => a.position - b.position);
    const positionsContiguous = sorted.every((row, index) => row.position === index + 1);
    const localesMatch = actualForCommunity.every((row) => row.locale === community.defaultLocale);
    const expectedIdsPresent = expectedForCommunity.every((expected) =>
      actualForCommunity.some((row) => row.id === expected.id),
    );
    if (!positionsContiguous || !localesMatch || !expectedIdsPresent) {
      orderingOk = false;
      break;
    }
  }

  const allCanonicalSignalIdsPresent = Object.values(FOUNDATION_SIGNAL_IDS).every((id) => {
    const expected = FOUNDATION_SIGNALS.find((signal) => signal.id === id);
    if (!expected) {
      return false;
    }
    const communitySignals = signalsByCommunityId.get(expected.communityId) ?? [];
    return communitySignals.some((row) => row.id === id);
  });

  // seedControlledActor only ever inserts the single fixed-ID controlled
  // actor when it was missing and upserts it in place otherwise — it never
  // touches any other actor row. The mutation never touches
  // signal_confirmations. So the only actor-count change a correct run can
  // produce is gaining exactly the controlled actor if it did not already
  // exist; every other actor and every confirmation must pass through
  // unchanged from whatever was present before the mutation.
  const expectedActors = baselineCounts.actors + (baselineCounts.controlledActors === 0 ? 1 : 0);

  if (
    counts.communities !== EXPECTED_COMMUNITY_COUNT ||
    counts.signals !== EXPECTED_SIGNAL_COUNT ||
    counts.actors !== expectedActors ||
    counts.controlledActors !== 1 ||
    counts.confirmations !== baselineCounts.confirmations ||
    !communitiesOk ||
    !signalsOk ||
    !actorOk ||
    !orderingOk ||
    !allCanonicalSignalIdsPresent
  ) {
    throw new StagingSeedError(
      'POSTCHECK_INVARIANT_FAILED',
      'Post-seed invariants failed for staging canonical baseline',
    );
  }

  return counts;
}

/**
 * Apply and verify the canonical staging foundation + controlled actor under
 * an advisory lock and a single transaction. Staging-only.
 */
export async function runStagingSeed(
  options: RunStagingSeedOptions = {},
): Promise<StagingSeedResult> {
  const env = options.env ?? process.env;

  const databaseUrl = requireStagingEnv(env);
  logEvent('env_check', 'ok', { appEnv: 'staging' });

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
  });

  let lockClient: PoolClient | undefined;
  let lockAcquired = false;

  try {
    logEvent('lock_acquire', 'ok');
    lockClient = await pool.connect();
    const lockResult = await lockClient.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS acquired`,
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;
    if (!lockAcquired) {
      throw new StagingSeedError(
        'LOCK_HELD',
        'Another staging seed execution holds the advisory lock',
      );
    }

    const db = drizzle(pool, { schema });

    const baseline = await assessBaseline(db);
    logEvent('preflight', baseline.kind === 'refuse' ? 'fail' : 'ok', {
      baseline: baseline.kind,
      communities: baseline.counts.communities,
      signals: baseline.counts.signals,
      actors: baseline.counts.actors,
      controlledActors: baseline.counts.controlledActors,
      confirmations: baseline.counts.confirmations,
      reason: baseline.refuseReason ?? null,
    });

    if (baseline.kind === 'refuse') {
      throw new StagingSeedError(
        baseline.refuseCode ?? 'PREFLIGHT_UNEXPECTED_ROWS',
        baseline.refuseReason ?? 'staging_seed_preflight_refused',
      );
    }

    if (baseline.kind === 'exact') {
      const counts = await assertPostInvariants(db, baseline.counts);
      logEvent('postcheck', 'ok', { ...counts, outcome: 'already_canonical' });
      logEvent('complete', 'ok', { outcome: 'already_canonical', ...counts });
      return { outcome: 'already_canonical', counts };
    }

    const mutateAction =
      baseline.kind === 'content_drift'
        ? 'reconcile_foundation_content'
        : baseline.kind === 'canonical_subset'
          ? 'complete_canonical_subset'
          : 'seed_foundation_and_controlled_actor';
    logEvent('mutate', 'ok', { action: mutateAction, baseline: baseline.kind });
    const counts = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await seedFoundationContent(txDb);
      await seedControlledActor(txDb);
      if (options.injectFailureAfterMutation === true) {
        throw new StagingSeedError('INJECTED_FAILURE', 'Injected failure after mutation');
      }
      return await assertPostInvariants(txDb, baseline.counts);
    });

    const outcome: StagingSeedOutcome =
      baseline.kind === 'content_drift'
        ? 'reconciled'
        : baseline.kind === 'canonical_subset'
          ? 'completed_subset'
          : 'seeded';
    logEvent('postcheck', 'ok', { ...counts, outcome });
    logEvent('complete', 'ok', { outcome, ...counts });
    return { outcome, counts };
  } catch (error: unknown) {
    const code = error instanceof StagingSeedError ? error.code : 'UNEXPECTED';
    const message = error instanceof Error ? error.message : 'Staging seed failed';
    logEvent('error', 'fail', { code, reason: message });
    throw error;
  } finally {
    if (lockClient !== undefined) {
      try {
        if (lockAcquired) {
          await lockClient.query(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
        }
      } catch {
        // Session end releases the lock; never mask the primary error.
      }
      lockClient.release();
    }
    await pool.end();
  }
}

export function runStagingSeedCli(env: NodeJS.ProcessEnv = process.env): void {
  runStagingSeed({ env })
    .then((result) => {
      process.stdout.write(
        `Staging seed ${result.outcome}: communities=${String(result.counts.communities)} signals=${String(result.counts.signals)} actors=${String(result.counts.actors)} controlledActors=${String(result.counts.controlledActors)} confirmations=${String(result.counts.confirmations)}\n`,
      );
      process.exitCode = 0;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Staging seed failed';
      const code = error instanceof StagingSeedError ? error.code : 'UNEXPECTED';
      process.stderr.write(`${code}: ${message}\n`);
      process.exitCode = 1;
    });
}
