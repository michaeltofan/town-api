import { and, eq, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../db/client.js';
import {
  actors,
  signalDiscussionContributions,
  signalSubmissions,
} from '../db/schema.js';
import { FOUNDATION_COMMUNITY_IDS, FOUNDATION_SIGNAL_IDS } from '../db/seeds/foundation-content.js';
import { ensureDiscussionSessionForSignal } from '../db/repositories/discussion-session.js';

/**
 * Staging-only fixture helper for platform submissions/discussions moderation.
 *
 * Safety:
 * - refuses every APP_ENV except staging
 * - uses fixed fixture IDs + an explicit `[platform-moderation-fixture]` marker
 * - never mutates rows that are not those fixture IDs
 * - cleanup deletes only the fixture rows
 */

const ACCOUNT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PLATFORM_MODERATION_FIXTURE_MARKER = '[platform-moderation-fixture]';
export const PLATFORM_MODERATION_FIXTURE_SUBMISSION_ID =
  '00000000-0000-4000-8000-00000000f101';
export const PLATFORM_MODERATION_FIXTURE_CONTRIBUTION_ID =
  '00000000-0000-4000-8000-00000000f102';
export const PLATFORM_MODERATION_FIXTURE_SESSION_ID = '00000000-0000-4000-8000-00000000f103';

export type SeedModerationFixturesErrorCode =
  | 'APP_ENV_NOT_STAGING'
  | 'DATABASE_URL_REQUIRED'
  | 'ACCOUNT_ID_REQUIRED'
  | 'ACCOUNT_ID_INVALID'
  | 'MODE_INVALID'
  | 'ACTOR_NOT_FOUND';

export class SeedModerationFixturesError extends Error {
  readonly code: SeedModerationFixturesErrorCode;

  constructor(code: SeedModerationFixturesErrorCode, message: string) {
    super(message);
    this.name = 'SeedModerationFixturesError';
    this.code = code;
  }
}

export type SeedModerationFixturesMode = 'create' | 'cleanup';

export type SeedModerationFixturesResult = {
  readonly mode: SeedModerationFixturesMode;
  readonly accountId: string;
  readonly submissionId: string;
  readonly contributionId: string;
  readonly signalId: string;
  readonly created: boolean;
  readonly cleaned: boolean;
};

export type RunSeedModerationFixturesOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly mode: SeedModerationFixturesMode;
  readonly accountId: string;
  readonly now?: () => Date;
};

function requireStagingEnv(env: NodeJS.ProcessEnv): string {
  if (env.APP_ENV !== 'staging') {
    throw new SeedModerationFixturesError(
      'APP_ENV_NOT_STAGING',
      'Platform moderation fixtures require APP_ENV=staging and refuse all other environments',
    );
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new SeedModerationFixturesError(
      'DATABASE_URL_REQUIRED',
      'DATABASE_URL is required for platform moderation fixtures',
    );
  }
  return databaseUrl;
}

function requireAccountId(accountId: string): string {
  if (!accountId || accountId.trim() === '') {
    throw new SeedModerationFixturesError(
      'ACCOUNT_ID_REQUIRED',
      '--account-id <uuid> is required',
    );
  }
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new SeedModerationFixturesError('ACCOUNT_ID_INVALID', 'account-id must be a UUID');
  }
  return accountId;
}

export async function runSeedModerationFixtures(
  options: RunSeedModerationFixturesOptions,
): Promise<SeedModerationFixturesResult> {
  const env = options.env ?? process.env;
  const databaseUrl = requireStagingEnv(env);
  const accountId = requireAccountId(options.accountId);
  const mode = options.mode;

  const nowIso = (options.now?.() ?? new Date()).toISOString();
  const database = createDatabase({
    connectionString: databaseUrl,
    poolMax: 1,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 5_000,
  });
  const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;

  try {
    if (mode === 'cleanup') {
      await database.db
        .delete(signalDiscussionContributions)
        .where(eq(signalDiscussionContributions.id, PLATFORM_MODERATION_FIXTURE_CONTRIBUTION_ID));
      await database.db
        .delete(signalSubmissions)
        .where(eq(signalSubmissions.id, PLATFORM_MODERATION_FIXTURE_SUBMISSION_ID));
      // Leave discussion session in place; it may be shared with real contributions.
      return {
        mode: 'cleanup',
        accountId,
        submissionId: PLATFORM_MODERATION_FIXTURE_SUBMISSION_ID,
        contributionId: PLATFORM_MODERATION_FIXTURE_CONTRIBUTION_ID,
        signalId,
        created: false,
        cleaned: true,
      };
    }

    const actorRows = await database.db
      .select({ id: actors.id })
      .from(actors)
      .where(
        and(eq(actors.accountId, accountId), eq(actors.communityId, FOUNDATION_COMMUNITY_IDS.milanoIt)),
      )
      .limit(1);
    const actorId = actorRows[0]?.id;
    if (!actorId) {
      throw new SeedModerationFixturesError(
        'ACTOR_NOT_FOUND',
        'No Milano actor found for the provided account-id',
      );
    }

    await database.db
      .delete(signalDiscussionContributions)
      .where(eq(signalDiscussionContributions.id, PLATFORM_MODERATION_FIXTURE_CONTRIBUTION_ID));
    await database.db
      .delete(signalSubmissions)
      .where(eq(signalSubmissions.id, PLATFORM_MODERATION_FIXTURE_SUBMISSION_ID));

    await database.db.insert(signalSubmissions).values({
      id: PLATFORM_MODERATION_FIXTURE_SUBMISSION_ID,
      accountId,
      actorId,
      communityId: FOUNDATION_COMMUNITY_IDS.milanoIt,
      headline: `${PLATFORM_MODERATION_FIXTURE_MARKER} pending tram delay`,
      body: `${PLATFORM_MODERATION_FIXTURE_MARKER} Controlled staging fixture. Safe to reject/restore.`,
      status: 'pending_review',
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    const session = await ensureDiscussionSessionForSignal(database.db, {
      signalId,
      id: PLATFORM_MODERATION_FIXTURE_SESSION_ID,
      now: nowIso,
    });

    await database.db.insert(signalDiscussionContributions).values({
      id: PLATFORM_MODERATION_FIXTURE_CONTRIBUTION_ID,
      sessionId: session.id,
      signalId,
      actorId,
      text: `${PLATFORM_MODERATION_FIXTURE_MARKER} Controlled staging discussion contribution. Safe to hide/unhide.`,
      intent: 'observation',
      createdAt: nowIso,
    });

    // Guard against accidental broad inserts: only fixture-marked rows for these IDs.
    const markerCheck = await database.db
      .select({ id: signalSubmissions.id })
      .from(signalSubmissions)
      .where(
        and(
          eq(signalSubmissions.id, PLATFORM_MODERATION_FIXTURE_SUBMISSION_ID),
          like(signalSubmissions.headline, `${PLATFORM_MODERATION_FIXTURE_MARKER}%`),
        ),
      )
      .limit(1);
    if (!markerCheck[0]) {
      throw new Error('Fixture submission marker verification failed');
    }

    return {
      mode: 'create',
      accountId,
      submissionId: PLATFORM_MODERATION_FIXTURE_SUBMISSION_ID,
      contributionId: PLATFORM_MODERATION_FIXTURE_CONTRIBUTION_ID,
      signalId,
      created: true,
      cleaned: false,
    };
  } finally {
    await database.close();
  }
}

function parseArgs(argv: string[]): {
  mode: SeedModerationFixturesMode;
  accountId: string;
} {
  let mode: SeedModerationFixturesMode | null = null;
  let accountId = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') {
      mode = argv[i + 1] as SeedModerationFixturesMode;
      i += 1;
    } else if (arg === '--account-id') {
      accountId = argv[i + 1] ?? '';
      i += 1;
    }
  }
  if (mode !== 'create' && mode !== 'cleanup') {
    throw new SeedModerationFixturesError(
      'MODE_INVALID',
      'Usage: --mode create|cleanup --account-id <uuid>',
    );
  }
  return { mode, accountId };
}

export async function runSeedModerationFixturesCli(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  try {
    const args = parseArgs(argv);
    const result = await runSeedModerationFixtures(args);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        requestId: randomUUID(),
        ...result,
        marker: PLATFORM_MODERATION_FIXTURE_MARKER,
      })}\n`,
    );
  } catch (error: unknown) {
    const code =
      error instanceof SeedModerationFixturesError ? error.code : 'PLATFORM_MODERATION_FIXTURE_FAILED';
    const message = error instanceof Error ? error.message : 'Platform moderation fixture failed';
    process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`);
    process.exitCode = 1;
  }
}
