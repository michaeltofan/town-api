import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { buildApp, type AppInstance } from '../../src/app.js';
import { createInMemoryTestDeliveryAdapter } from '../../src/ceremony/email-verification/delivery.js';
import type { Env } from '../../src/config/env.js';
import { createDatabase } from '../../src/db/client.js';
import { actors } from '../../src/db/schema.js';
import { FOUNDATION_COMMUNITY_IDS } from '../../src/db/seeds/foundation-content.js';
import { COMMUNITY_COMMITMENT_VERSION } from '../../src/membership/community-commitment.js';
import { createEligibleTestResolver } from '../../src/membership/local-eligibility.js';
import type { LocalParticipationEligibilityResolver } from '../../src/membership/local-eligibility.js';
import { activateMembership } from '../../src/membership/transitions/activate.js';
import { expireMembership } from '../../src/membership/transitions/expire.js';
import { reactivateMembership } from '../../src/membership/transitions/reactivate.js';
import { scheduleMembershipCancellation } from '../../src/membership/transitions/schedule-cancellation.js';
import type { MembershipTransitionOutcome } from '../../src/membership/transitions/shared.js';
import {
  createPasskeyAuthenticationEnv,
  registerActivePasskeyAccount,
} from './passkey-authentication.js';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './pg.js';

export { createEligibleTestResolver, FOUNDATION_COMMUNITY_IDS };

export type MembershipTestApp = {
  app: AppInstance;
  pool: Pool;
  env: Env;
  delivery: ReturnType<typeof createInMemoryTestDeliveryAdapter>;
};

export type MembershipTestAppOptions = {
  now?: () => string;
  generateId?: () => string;
  generateToken?: () => string;
  localEligibilityResolver?: LocalParticipationEligibilityResolver;
  envOverrides?: Partial<NodeJS.ProcessEnv>;
  poolMax?: number;
};

export async function createMembershipTestApp(
  options: MembershipTestAppOptions = {},
): Promise<MembershipTestApp> {
  const databaseUrl = requireDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  await resetMigrateSeedFoundationAndActor(pool);

  const env = createPasskeyAuthenticationEnv({
    ...(options.envOverrides ?? {}),
  });
  const delivery = createInMemoryTestDeliveryAdapter();
  const database = createDatabase({
    connectionString: env.DATABASE_URL,
    poolMax: options.poolMax ?? env.DB_POOL_MAX,
    connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
  });

  const app = await buildApp({
    env,
    logger: false,
    database,
    emailVerification: {
      deliveryAdapter: delivery,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
    passwordSetup: {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
    },
    passkeyRegistration: {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
      ...(options.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
    },
    passkeyAuthentication: {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
      ...(options.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
    },
    passkeyManagement: {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
      ...(options.generateToken !== undefined ? { generateToken: options.generateToken } : {}),
    },
    membership: {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateId !== undefined ? { generateId: options.generateId } : {}),
      ...(options.localEligibilityResolver !== undefined
        ? { localEligibilityResolver: options.localEligibilityResolver }
        : {}),
    },
  });
  await app.ready();

  return { app, pool, env, delivery };
}

/**
 * Attach the account's linked civic actor to the given community without an
 * explicit community commitment. Used to prove community_id alone is not
 * acceptance. Never touches the controlled test actor.
 */
export async function setLinkedCivicActorCommunity(
  app: AppInstance,
  input: { accountId: string; communityId: string; now?: string },
): Promise<{ actorId: string }> {
  const nowIso = input.now ?? new Date().toISOString();
  const rows = await app.database.db
    .select()
    .from(actors)
    .where(and(eq(actors.accountId, input.accountId), eq(actors.kind, 'civic')))
    .limit(1);
  const actor = rows[0];
  if (!actor) {
    throw new Error('linked civic actor missing for account');
  }
  await app.database.db
    .update(actors)
    .set({ communityId: input.communityId, updatedAt: nowIso })
    .where(eq(actors.id, actor.id));
  return { actorId: actor.id };
}

/**
 * Record a valid Membership V1 community commitment for the linked civic actor.
 * Does not write local_eligibility_verified_at.
 */
export async function recordLinkedCivicActorCommunityCommitment(
  app: AppInstance,
  input: { accountId: string; communityId: string; now?: string },
): Promise<{ actorId: string }> {
  const nowIso = input.now ?? new Date().toISOString();
  const rows = await app.database.db
    .select()
    .from(actors)
    .where(and(eq(actors.accountId, input.accountId), eq(actors.kind, 'civic')))
    .limit(1);
  const actor = rows[0];
  if (!actor) {
    throw new Error('linked civic actor missing for account');
  }
  await app.database.db
    .update(actors)
    .set({
      communityId: input.communityId,
      communityCommitmentAcceptedAt: nowIso,
      communityCommitmentVersion: COMMUNITY_COMMITMENT_VERSION,
      updatedAt: nowIso,
    })
    .where(eq(actors.id, actor.id));
  return { actorId: actor.id };
}

export type MembershipFixture = {
  accountId: string;
  actorId: string;
  sessionToken: string;
  sessionExpiresAt: string;
  entitlementOutcome: MembershipTransitionOutcome;
};

export type ActivateMembershipFixtureInput = {
  app: AppInstance;
  delivery: ReturnType<typeof createInMemoryTestDeliveryAdapter>;
  email?: string;
  effectiveAt?: string;
  accessUntil?: string;
  communityId?: string;
  now?: string;
  linkActorToCommunity?: boolean;
};

export async function activatePasskeyAccountAndLinkCommunity(input: {
  app: AppInstance;
  delivery: ReturnType<typeof createInMemoryTestDeliveryAdapter>;
  email?: string;
  communityId?: string;
  linkCommunity?: boolean;
}): Promise<{
  accountId: string;
  actorId: string;
  material: Awaited<ReturnType<typeof registerActivePasskeyAccount>>['material'];
  userHandle: Awaited<ReturnType<typeof registerActivePasskeyAccount>>['userHandle'];
}> {
  const registration = await registerActivePasskeyAccount(
    input.app,
    input.delivery,
    input.email ?? 'Membership.Fixture+setup@example.com',
  );
  const community = input.communityId ?? FOUNDATION_COMMUNITY_IDS.milanoIt;
  if (input.linkCommunity === false) {
    const rows = await input.app.database.db
      .select()
      .from(actors)
      .where(and(eq(actors.accountId, registration.accountId), eq(actors.kind, 'civic')))
      .limit(1);
    const actor = rows[0];
    if (!actor) {
      throw new Error('linked civic actor missing for account');
    }
    return {
      accountId: registration.accountId,
      actorId: actor.id,
      material: registration.material,
      userHandle: registration.userHandle,
    };
  }
  const { actorId } = await recordLinkedCivicActorCommunityCommitment(input.app, {
    accountId: registration.accountId,
    communityId: community,
  });
  return {
    accountId: registration.accountId,
    actorId,
    material: registration.material,
    userHandle: registration.userHandle,
  };
}

export async function activateTestMembership(
  app: AppInstance,
  input: {
    accountId: string;
    effectiveAt: string;
    accessUntil: string;
    sourceEventId?: string;
    now?: string;
  },
): Promise<MembershipTransitionOutcome> {
  return activateMembership(
    app.database.db,
    {
      source: 'test_fixture',
      sourceEventId: input.sourceEventId ?? `test:activate:${randomUUID()}`,
      eventType: 'activate',
      accountId: input.accountId,
      effectiveAt: input.effectiveAt,
      accessUntil: input.accessUntil,
    },
    {
      nodeEnv: 'test',
      processedAt: input.now ?? input.effectiveAt,
    },
  );
}

export async function scheduleTestCancellation(
  app: AppInstance,
  input: {
    accountId: string;
    effectiveAt: string;
    sourceEventId?: string;
    now?: string;
  },
): Promise<MembershipTransitionOutcome> {
  return scheduleMembershipCancellation(
    app.database.db,
    {
      source: 'test_fixture',
      sourceEventId: input.sourceEventId ?? `test:schedule:${randomUUID()}`,
      eventType: 'schedule_cancellation',
      accountId: input.accountId,
      effectiveAt: input.effectiveAt,
    },
    {
      nodeEnv: 'test',
      processedAt: input.now ?? input.effectiveAt,
    },
  );
}

export async function reactivateTestMembership(
  app: AppInstance,
  input: {
    accountId: string;
    effectiveAt: string;
    sourceEventId?: string;
    now?: string;
  },
): Promise<MembershipTransitionOutcome> {
  return reactivateMembership(
    app.database.db,
    {
      source: 'test_fixture',
      sourceEventId: input.sourceEventId ?? `test:reactivate:${randomUUID()}`,
      eventType: 'reactivate',
      accountId: input.accountId,
      effectiveAt: input.effectiveAt,
    },
    {
      nodeEnv: 'test',
      processedAt: input.now ?? input.effectiveAt,
    },
  );
}

export async function expireTestMembership(
  app: AppInstance,
  input: {
    accountId: string;
    effectiveAt: string;
    sourceEventId?: string;
    now?: string;
  },
): Promise<MembershipTransitionOutcome> {
  return expireMembership(
    app.database.db,
    {
      source: 'test_fixture',
      sourceEventId: input.sourceEventId ?? `test:expire:${randomUUID()}`,
      eventType: 'expire',
      accountId: input.accountId,
      effectiveAt: input.effectiveAt,
    },
    {
      nodeEnv: 'test',
      processedAt: input.now ?? input.effectiveAt,
    },
  );
}
