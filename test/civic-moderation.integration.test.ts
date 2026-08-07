import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppInstance } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { platformOperators } from '../src/db/schema.js';
import {
  activatePasskeyAccountAndLinkCommunity,
  activateTestMembership,
  createEligibleTestResolver,
  createMembershipTestApp,
} from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';
import type { SoftPasskeyMaterial } from './helpers/webauthn-soft-authenticator.js';

/**
 * §14: moderate_civic_process — hide/restore civic content, resolve a
 * mandate contestation (§10), resolve a stalled verification dispute
 * (§13). Mirrors the account setup used by the other §9-§13 extension
 * tests: 5 confirmers + 5 proposal authors, one of whom is also granted
 * the platform 'moderator' role to exercise these operator-only routes.
 */
describe('civic moderation (governance spec §14)', () => {
  let ctx: Awaited<ReturnType<typeof createMembershipTestApp>>;
  let confirmerSessionTokens: string[];
  let authorSessionTokens: string[];
  let operatorAccountId: string;
  let operatorSessionToken: string;
  let operatorMaterial: SoftPasskeyMaterial;

  async function makeParticipant(emailPrefix: string): Promise<{
    accountId: string;
    sessionToken: string;
    material: SoftPasskeyMaterial;
  }> {
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
    return {
      accountId: registration.accountId,
      sessionToken: login.sessionToken,
      material: registration.material,
    };
  }

  // Session absolute expiry (24h) is checked against whichever `now` the
  // serving app instance uses, so a session minted against the real clock
  // reads as expired on a future-clock app instance. Operator routes
  // exercised on buildFutureClockApp() need a session minted on that same
  // future-clock instance instead of reusing operatorSessionToken.
  async function loginOperatorOn(app: AppInstance): Promise<string> {
    // signCount must exceed the counter from the operator's earlier login in
    // makeParticipant() to avoid tripping WebAuthn replay detection.
    const login = await loginMobileSession({ app, material: operatorMaterial, signCount: 2 });
    return login.sessionToken;
  }

  async function buildFutureClockApp(now: () => string): Promise<AppInstance> {
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
      passkeyAuthentication: { now },
    });
  }

  beforeAll(async () => {
    ctx = await createMembershipTestApp({
      localEligibilityResolver: createEligibleTestResolver(),
    });
    confirmerSessionTokens = [];
    for (let i = 0; i < 5; i += 1) {
      const confirmer = await makeParticipant(`ModerationConfirmer${String(i)}`);
      confirmerSessionTokens.push(confirmer.sessionToken);
    }
    authorSessionTokens = [];
    let lastAuthorAccountId: string | undefined;
    let lastAuthorMaterial: SoftPasskeyMaterial | undefined;
    for (let i = 0; i < 5; i += 1) {
      const author = await makeParticipant(`ModerationAuthor${String(i)}`);
      authorSessionTokens.push(author.sessionToken);
      lastAuthorAccountId = author.accountId;
      lastAuthorMaterial = author.material;
    }
    // Reuses the last author account as the operator (rather than creating an
    // 11th account) to stay within the email-verification IP rate limit that
    // the other 10-account extension test suites already sit right at.
    const lastAuthorSessionToken = authorSessionTokens[4];
    if (
      lastAuthorSessionToken === undefined ||
      lastAuthorAccountId === undefined ||
      lastAuthorMaterial === undefined
    ) {
      throw new Error('expected a last author account');
    }
    operatorAccountId = lastAuthorAccountId;
    operatorSessionToken = lastAuthorSessionToken;
    operatorMaterial = lastAuthorMaterial;
    await ctx.app.database.db.insert(platformOperators).values({
      accountId: operatorAccountId,
      role: 'moderator',
      grantedAt: '2026-07-17T12:00:00.000Z',
      grantedByAccountId: null,
      revokedAt: null,
      updatedAt: '2026-07-17T12:00:00.000Z',
    });
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function driveSignalToVerification(
    slug: string,
    position: number,
  ): Promise<{ signalId: string; processId: string; proposalIds: string[] }> {
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
          title: `Moderation proposal ${String(index)}`,
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

    const processRow = await ctx.pool.query<{ id: string }>(
      'SELECT id FROM town.civic_processes WHERE signal_id = $1',
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

    return { signalId, processId, proposalIds };
  }

  it('hides and unhides a civic proposal, requiring the moderate_civic_process capability', async () => {
    const { signalId, proposalIds } = await driveSignalToVerification(
      'moderation-proposal-test',
      32501,
    );
    const proposalId = proposalIds[1];
    if (proposalId === undefined) throw new Error('expected a proposal id');
    const nonOperatorSessionToken = confirmerSessionTokens[0];
    if (nonOperatorSessionToken === undefined) throw new Error('expected a session token');

    const nonOperator = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/civic/proposals/${proposalId}/hide`,
      headers: { authorization: `Session ${nonOperatorSessionToken}` },
      payload: { reason: 'off_topic' },
    });
    expect(nonOperator.statusCode).toBe(404);

    const hide = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/civic/proposals/${proposalId}/hide`,
      headers: { authorization: `Session ${operatorSessionToken}` },
      payload: { reason: 'off_topic' },
    });
    expect(hide.statusCode).toBe(200);
    expect(hide.json()).toMatchObject({
      data: { contentId: proposalId, hidden: true, hiddenReason: 'off_topic', changed: true },
    });

    const unhide = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/civic/proposals/${proposalId}/unhide`,
      headers: { authorization: `Session ${operatorSessionToken}` },
    });
    expect(unhide.statusCode).toBe(200);
    expect(unhide.json()).toMatchObject({ data: { hidden: false, changed: true } });

    void signalId;
  });

  it('hides a civic deliberation contribution and a verification evidence item', async () => {
    const { signalId, processId } = await driveSignalToVerification(
      'moderation-content-test',
      32502,
    );

    const contributionRow = await ctx.pool.query<{ id: string }>(
      'SELECT id FROM town.civic_deliberation_contributions WHERE process_id = $1 LIMIT 1',
      [processId],
    );
    const contributionId = contributionRow.rows[0]?.id;
    if (!contributionId) throw new Error('missing contribution id');

    const hideContribution = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/civic/deliberation-contributions/${contributionId}/hide`,
      headers: { authorization: `Session ${operatorSessionToken}` },
      payload: { reason: 'spam' },
    });
    expect(hideContribution.statusCode).toBe(200);
    expect(hideContribution.json()).toMatchObject({
      data: { hidden: true, hiddenReason: 'spam', changed: true },
    });

    const evidenceSessionToken = confirmerSessionTokens[0];
    if (evidenceSessionToken === undefined) throw new Error('expected a session token');
    const evidence = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/verification/evidence`,
      headers: { authorization: `Session ${evidenceSessionToken}` },
      payload: { text: 'Photo evidence of the completed work.', url: null },
    });
    expect(evidence.statusCode).toBe(201);
    const evidenceId = evidence.json<{ data: { id: string } }>().data.id;

    const hideEvidence = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/civic/verification-evidence/${evidenceId}/hide`,
      headers: { authorization: `Session ${operatorSessionToken}` },
      payload: { reason: 'abusive' },
    });
    expect(hideEvidence.statusCode).toBe(200);
    expect(hideEvidence.json()).toMatchObject({
      data: { hidden: true, hiddenReason: 'abusive', changed: true },
    });
  });

  it('lists and resolves a pending mandate contestation, once, permanently', async () => {
    const { signalId } = await driveSignalToVerification('moderation-contestation-test', 32503);

    const filerSessionToken = confirmerSessionTokens[0];
    if (filerSessionToken === undefined) throw new Error('expected a session token');
    const filed = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/mandate/contest`,
      headers: { authorization: `Session ${filerSessionToken}` },
      payload: { reasonKey: 'count_discrepancy' },
    });
    expect(filed.statusCode).toBe(201);

    const queue = await ctx.app.inject({
      method: 'GET',
      url: '/v1/platform/civic/contestations',
      headers: { authorization: `Session ${operatorSessionToken}` },
    });
    expect(queue.statusCode).toBe(200);
    const body = queue.json<{ data: { contestations: { id: string; status: string }[] } }>();
    const contestation = body.data.contestations.find((c) => c.status === 'pending');
    expect(contestation).toBeDefined();
    if (!contestation) throw new Error('expected a pending contestation');

    const resolve = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/civic/contestations/${contestation.id}/resolve`,
      headers: { authorization: `Session ${operatorSessionToken}` },
      payload: { status: 'rejected', reviewNote: 'Recount matches the published tally.' },
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json()).toMatchObject({
      data: { contestationId: contestation.id, status: 'rejected', changed: true },
    });

    const resolveAgain = await ctx.app.inject({
      method: 'POST',
      url: `/v1/platform/civic/contestations/${contestation.id}/resolve`,
      headers: { authorization: `Session ${operatorSessionToken}` },
      payload: { status: 'upheld' },
    });
    expect(resolveAgain.statusCode).toBe(200);
    expect(resolveAgain.json()).toMatchObject({
      data: { status: 'rejected', changed: false },
    });
  });

  it('lists and resolves an escalated verification dispute, once, permanently', async () => {
    const { signalId, processId } = await driveSignalToVerification(
      'moderation-dispute-test',
      32504,
    );

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

    const fifteenDaysFromNow = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
    const futureApp = await buildFutureClockApp(() => fifteenDaysFromNow);
    try {
      const futureOperatorSessionToken = await loginOperatorOn(futureApp);
      const queue = await futureApp.inject({
        method: 'GET',
        url: '/v1/platform/civic/verification-disputes',
        headers: { authorization: `Session ${futureOperatorSessionToken}` },
      });
      expect(queue.statusCode).toBe(200);
      const body = queue.json<{ data: { disputes: { processId: string }[] } }>();
      expect(body.data.disputes.some((d) => d.processId === processId)).toBe(true);

      const resolve = await futureApp.inject({
        method: 'POST',
        url: `/v1/platform/civic/verification-disputes/${processId}/resolve`,
        headers: { authorization: `Session ${futureOperatorSessionToken}` },
        payload: { outcome: 'delivered', reviewNote: 'Site visit confirmed delivery.' },
      });
      expect(resolve.statusCode).toBe(200);
      expect(resolve.json()).toMatchObject({
        data: { processId, outcome: 'delivered', changed: true },
      });

      // Never touches current_stage — the process stays "verification" forever.
      const processState = await ctx.pool.query<{ current_stage: string }>(
        'SELECT current_stage FROM town.civic_processes WHERE id = $1',
        [processId],
      );
      expect(processState.rows[0]?.current_stage).toBe('verification');

      const resolveAgain = await futureApp.inject({
        method: 'POST',
        url: `/v1/platform/civic/verification-disputes/${processId}/resolve`,
        headers: { authorization: `Session ${futureOperatorSessionToken}` },
        payload: { outcome: 'not_delivered' },
      });
      expect(resolveAgain.statusCode).toBe(200);
      expect(resolveAgain.json()).toMatchObject({
        data: { outcome: 'delivered', changed: false },
      });
    } finally {
      await futureApp.close();
    }
  });
});
