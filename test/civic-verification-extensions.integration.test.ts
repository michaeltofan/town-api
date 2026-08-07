import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppInstance } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import {
  activatePasskeyAccountAndLinkCommunity,
  activateTestMembership,
  createEligibleTestResolver,
  createMembershipTestApp,
} from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';

/**
 * civic_process_transitions is append-only (rejects UPDATE at the trigger
 * level) — there is no historical row to rewind the way other tests rewind
 * a mutable civic_processes column. Instead, build a second app instance
 * against the SAME live database (no reset, no migration) with a fixed
 * future `now`, so the lazy 14-day escalation math reads as if time had
 * actually passed.
 */
async function buildFutureClockApp(
  ctx: Awaited<ReturnType<typeof createMembershipTestApp>>,
  now: () => string,
): Promise<AppInstance> {
  const database = createDatabase({
    connectionString: ctx.env.DATABASE_URL,
    poolMax: 1,
    connectionTimeoutMs: ctx.env.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMs: ctx.env.DB_IDLE_TIMEOUT_MS,
  });
  return buildApp({
    env: ctx.env,
    logger: false,
    database,
    membership: { now },
  });
}

/**
 * Mirrors civic-action-extensions.integration.test.ts's account setup: 5
 * confirmers + 5 proposal authors, driven all the way through a decided
 * mandate, action, and into an open (undecided) verification dispute.
 */
describe('civic verification dispute escalation (governance spec §13)', () => {
  let ctx: Awaited<ReturnType<typeof createMembershipTestApp>>;
  let confirmerSessionTokens: string[];
  let authorSessionTokens: string[];

  async function makeParticipant(emailPrefix: string): Promise<{ sessionToken: string }> {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: `${emailPrefix}+setup@example.com`,
    });
    await activateTestMembership(ctx.app, {
      accountId: registration.accountId,
      effectiveAt: '2026-07-17T12:00:00.000Z',
      accessUntil: '2030-01-01T00:00:00.000Z',
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    return { sessionToken: login.sessionToken };
  }

  beforeAll(async () => {
    ctx = await createMembershipTestApp({
      localEligibilityResolver: createEligibleTestResolver(),
    });
    confirmerSessionTokens = [];
    for (let i = 0; i < 5; i += 1) {
      const confirmer = await makeParticipant(`VerificationExtConfirmer${String(i)}`);
      confirmerSessionTokens.push(confirmer.sessionToken);
    }
    authorSessionTokens = [];
    for (let i = 0; i < 5; i += 1) {
      const author = await makeParticipant(`VerificationExtAuthor${String(i)}`);
      authorSessionTokens.push(author.sessionToken);
    }
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function driveSignalIntoOpenVerificationDispute(
    slug: string,
    position: number,
  ): Promise<{ signalId: string; processId: string }> {
    const signalId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO town.signals
       SELECT (jsonb_populate_record(
         NULL::town.signals,
         to_jsonb(source) || jsonb_build_object(
           'id', $1::uuid,
           'slug', $2::text,
           'position', $3::int,
           'created_at', now(),
           'updated_at', now(),
           'published_at', now()
         )
       )).*
       FROM town.signals source
       ORDER BY position
       LIMIT 1`,
      [signalId, slug, position],
    );

    for (const sessionToken of confirmerSessionTokens) {
      const response = await ctx.app.inject({
        method: 'PUT',
        url: `/v1/signals/${signalId}/confirmation`,
        headers: { authorization: `Session ${sessionToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
    }

    const proposalIds: string[] = [];
    for (const [index, sessionToken] of authorSessionTokens.entries()) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/v1/signals/${signalId}/civic-process/proposals`,
        headers: { authorization: `Session ${sessionToken}` },
        payload: {
          title: `Verification extensions proposal ${String(index)}`,
          body: `Body for proposal ${String(index)}.`,
          expectedOutcome: `Expected outcome ${String(index)}.`,
        },
      });
      expect(response.statusCode).toBe(201);
      proposalIds.push(response.json<{ data: { id: string } }>().data.id);
    }

    for (const [index, sessionToken] of confirmerSessionTokens.entries()) {
      const proposalId = proposalIds[index];
      if (proposalId === undefined) throw new Error('expected a proposal id');
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/v1/signals/${signalId}/civic-process/deliberation/proposals/${proposalId}/contributions`,
        headers: { authorization: `Session ${sessionToken}` },
        payload: {
          intent: 'observation',
          text: `A deliberation contribution number ${String(index)} with enough length.`,
        },
      });
      expect(response.statusCode).toBe(201);
    }

    const processRow = await ctx.pool.query<{ id: string; current_stage: string }>(
      'SELECT id, current_stage FROM town.civic_processes WHERE signal_id = $1',
      [signalId],
    );
    const processId = processRow.rows[0]?.id;
    if (!processId) throw new Error('missing process id');

    await ctx.pool.query(
      "UPDATE town.civic_processes SET voting_opens_at = now() - interval '1 second' WHERE id = $1",
      [processId],
    );
    const opened = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process`,
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ data: { currentStage: 'voting' } });

    const firstProposalId = proposalIds[0];
    if (firstProposalId === undefined) throw new Error('expected a first proposal id');
    for (const sessionToken of confirmerSessionTokens) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/v1/signals/${signalId}/civic-process/voting/vote`,
        headers: { authorization: `Session ${sessionToken}` },
        payload: { proposalId: firstProposalId },
      });
      expect(response.statusCode).toBe(201);
    }

    await ctx.pool.query(
      "UPDATE town.civic_processes SET voting_closes_at = now() - interval '1 second' WHERE id = $1",
      [processId],
    );
    const decided = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/mandate`,
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({
      data: { decided: true, contested: false, currentStage: 'action' },
    });

    const readySessionToken = confirmerSessionTokens[0];
    if (readySessionToken === undefined) throw new Error('expected a session token');
    const ready = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/verification/ready`,
      headers: { authorization: `Session ${readySessionToken}` },
    });
    expect(ready.statusCode).toBe(200);

    // A 2-3 split never reaches the 5-actor threshold on either side —
    // an open, honestly-reported dispute (§13).
    for (const sessionToken of confirmerSessionTokens.slice(0, 2)) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/v1/signals/${signalId}/civic-process/verification/confirm`,
        headers: { authorization: `Session ${sessionToken}` },
        payload: { outcome: 'delivered' },
      });
      expect(response.statusCode).toBe(201);
    }
    for (const sessionToken of confirmerSessionTokens.slice(2, 5)) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/v1/signals/${signalId}/civic-process/verification/confirm`,
        headers: { authorization: `Session ${sessionToken}` },
        payload: { outcome: 'not_delivered' },
      });
      expect(response.statusCode).toBe(201);
    }

    return { signalId, processId };
  }

  it('reports no escalation for a freshly-opened dispute', async () => {
    const { signalId } = await driveSignalIntoOpenVerificationDispute(
      'verification-ext-fresh-test',
      32401,
    );
    const verification = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/verification`,
    });
    expect(verification.statusCode).toBe(200);
    const body = verification.json<{
      data: {
        outcome: string | null;
        verificationOpenedAt: string | null;
        disputeEscalatesAt: string | null;
        disputeEscalated: boolean;
      };
    }>();
    expect(body.data.outcome).toBeNull();
    expect(body.data.verificationOpenedAt).not.toBeNull();
    expect(body.data.disputeEscalatesAt).not.toBeNull();
    expect(body.data.disputeEscalated).toBe(false);
    if (body.data.verificationOpenedAt && body.data.disputeEscalatesAt) {
      const openedMs = new Date(body.data.verificationOpenedAt).getTime();
      const escalatesMs = new Date(body.data.disputeEscalatesAt).getTime();
      expect(escalatesMs - openedMs).toBe(14 * 24 * 60 * 60 * 1000);
    }
  });

  it('escalates an open dispute after 14 days, with no invented resolution', async () => {
    const { signalId } = await driveSignalIntoOpenVerificationDispute(
      'verification-ext-escalated-test',
      32402,
    );

    const fifteenDaysFromNow = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
    const futureApp = await buildFutureClockApp(ctx, () => fifteenDaysFromNow);
    try {
      const verification = await futureApp.inject({
        method: 'GET',
        url: `/v1/signals/${signalId}/civic-process/verification`,
      });
      expect(verification.statusCode).toBe(200);
      const body = verification.json<{
        data: { outcome: string | null; disputeEscalated: boolean };
      }>();
      expect(body.data.disputeEscalated).toBe(true);
      // Escalated does not mean resolved — still no invented outcome.
      expect(body.data.outcome).toBeNull();
    } finally {
      await futureApp.close();
    }
  });
});
