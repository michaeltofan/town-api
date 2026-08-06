import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activatePasskeyAccountAndLinkCommunity,
  activateTestMembership,
  createEligibleTestResolver,
  createMembershipTestApp,
} from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';

/**
 * Registration goes through the real email-verification ceremony, which is
 * IP rate-limited (10 requests / 15 minutes in this policy — see
 * src/ceremony/email-verification/policy.ts). A handful of shared accounts,
 * reused across every test case in this file (each against its own fresh
 * signal/process so there is never an "already submitted" collision), keeps
 * this suite well under that limit instead of registering a new account per
 * assertion.
 */
describe('civic proposal rich object and lifecycle (governance spec §6)', () => {
  let ctx: Awaited<ReturnType<typeof createMembershipTestApp>>;
  let confirmerSessionTokens: string[];
  let authorSessionToken: string;
  let strangerSessionToken: string;

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
      const confirmer = await makeParticipant(`ProposalLifecycleConfirmer${String(i)}`);
      confirmerSessionTokens.push(confirmer.sessionToken);
    }
    authorSessionToken = (await makeParticipant('ProposalLifecycleAuthor')).sessionToken;
    strangerSessionToken = (await makeParticipant('ProposalLifecycleStranger')).sessionToken;
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function confirmAsParticipant(signalId: string, sessionToken: string): Promise<void> {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/signals/${signalId}/confirmation`,
      headers: { authorization: `Session ${sessionToken}` },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
  }

  async function driveSignalToProposals(slug: string, position: number): Promise<string> {
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
      await confirmAsParticipant(signalId, sessionToken);
    }
    const stage = await ctx.pool.query<{ current_stage: string }>(
      'SELECT current_stage FROM town.civic_processes WHERE signal_id = $1',
      [signalId],
    );
    expect(stage.rows[0]?.current_stage).toBe('proposals');
    return signalId;
  }

  it('creates a proposal with the rich object fields and defaults the rest to null', async () => {
    const signalId = await driveSignalToProposals('civic-proposal-rich-create-test', 32101);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/proposals`,
      headers: { authorization: `Session ${authorSessionToken}` },
      payload: {
        title: 'Repave the school entrance',
        body: 'Fix the lifted pavement slabs directly in front of the entrance.',
        expectedOutcome: 'A flat, safe pavement for pedestrians within the school zone.',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      data: {
        title: 'Repave the school entrance',
        expectedOutcome: 'A flat, safe pavement for pedestrians within the school zone.',
        targetInstitution: null,
        estimatedResources: null,
        indicativeDeadline: null,
        lifecycleState: 'published',
        revisedAt: null,
        withdrawnAt: null,
        isMine: true,
        canRevise: true,
        canWithdraw: true,
      },
    });
  });

  it('rejects creation missing the required expectedOutcome field', async () => {
    const signalId = await driveSignalToProposals('civic-proposal-missing-outcome-test', 32102);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/proposals`,
      headers: { authorization: `Session ${authorSessionToken}` },
      payload: {
        title: 'Repave the school entrance',
        body: 'Fix the lifted pavement slabs.',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('allows exactly one revision, preserves the prior version, and rejects a second revision', async () => {
    const signalId = await driveSignalToProposals('civic-proposal-revise-once-test', 32103);

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/proposals`,
      headers: { authorization: `Session ${authorSessionToken}` },
      payload: {
        title: 'Original title',
        body: 'Original body text here.',
        expectedOutcome: 'Original expected outcome.',
        targetInstitution: 'City Public Works',
      },
    });
    expect(created.statusCode).toBe(201);
    const proposalId = created.json<{ data: { id: string } }>().data.id;

    const firstRevision = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/signals/${signalId}/civic-process/proposals/${proposalId}`,
      headers: { authorization: `Session ${authorSessionToken}` },
      payload: {
        title: 'Revised title',
        body: 'Revised body text with more detail.',
        expectedOutcome: 'Revised expected outcome.',
        targetInstitution: 'City Public Works — Roads Division',
      },
    });
    expect(firstRevision.statusCode).toBe(200);
    expect(firstRevision.json()).toMatchObject({
      data: {
        title: 'Revised title',
        expectedOutcome: 'Revised expected outcome.',
        lifecycleState: 'revised',
        canRevise: false,
      },
    });
    expect(
      firstRevision.json<{ data: { revisedAt: string | null } }>().data.revisedAt,
    ).not.toBeNull();

    const revisionHistory = await ctx.pool.query<{
      previous_title: string;
      previous_expected_outcome: string;
    }>(
      'SELECT previous_title, previous_expected_outcome FROM town.civic_proposal_revisions WHERE proposal_id = $1',
      [proposalId],
    );
    expect(revisionHistory.rows).toEqual([
      {
        previous_title: 'Original title',
        previous_expected_outcome: 'Original expected outcome.',
      },
    ]);

    const secondRevision = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/signals/${signalId}/civic-process/proposals/${proposalId}`,
      headers: { authorization: `Session ${authorSessionToken}` },
      payload: {
        title: 'Third attempt title',
        body: 'Third attempt body text.',
        expectedOutcome: 'Third attempt outcome.',
      },
    });
    expect(secondRevision.statusCode).toBe(409);
    expect(secondRevision.json()).toMatchObject({
      error: { code: 'CIVIC_PROPOSAL_ALREADY_REVISED' },
    });
  });

  it('rejects revision by a non-author with 403', async () => {
    const signalId = await driveSignalToProposals('civic-proposal-revise-other-test', 32104);

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/proposals`,
      headers: { authorization: `Session ${authorSessionToken}` },
      payload: {
        title: 'Original title',
        body: 'Original body text.',
        expectedOutcome: 'Original expected outcome.',
      },
    });
    const proposalId = created.json<{ data: { id: string } }>().data.id;

    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/signals/${signalId}/civic-process/proposals/${proposalId}`,
      headers: { authorization: `Session ${strangerSessionToken}` },
      payload: {
        title: 'Hijacked title',
        body: 'Hijacked body.',
        expectedOutcome: 'Hijacked outcome.',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'CIVIC_PROPOSAL_NOT_AUTHOR' } });
  });

  it('withdraws a proposal, keeps its content visible, and blocks further edits', async () => {
    const signalId = await driveSignalToProposals('civic-proposal-withdraw-test', 32105);

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/proposals`,
      headers: { authorization: `Session ${authorSessionToken}` },
      payload: {
        title: 'A proposal that will be withdrawn',
        body: 'Body text.',
        expectedOutcome: 'Expected outcome.',
      },
    });
    const proposalId = created.json<{ data: { id: string } }>().data.id;

    const withdrawn = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/proposals/${proposalId}/withdraw`,
      headers: { authorization: `Session ${authorSessionToken}` },
    });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json()).toMatchObject({
      data: {
        title: 'A proposal that will be withdrawn',
        lifecycleState: 'withdrawn',
        canRevise: false,
        canWithdraw: false,
      },
    });
    expect(
      withdrawn.json<{ data: { withdrawnAt: string | null } }>().data.withdrawnAt,
    ).not.toBeNull();

    // Withdrawal is permanent — a second withdraw and a revision attempt both fail.
    const secondWithdraw = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/proposals/${proposalId}/withdraw`,
      headers: { authorization: `Session ${authorSessionToken}` },
    });
    expect(secondWithdraw.statusCode).toBe(409);

    const reviseAfterWithdraw = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/signals/${signalId}/civic-process/proposals/${proposalId}`,
      headers: { authorization: `Session ${authorSessionToken}` },
      payload: {
        title: 'Should not apply',
        body: 'Should not apply.',
        expectedOutcome: 'Should not apply.',
      },
    });
    expect(reviseAfterWithdraw.statusCode).toBe(409);

    // The list still shows the withdrawn proposal with its original content — never deleted.
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/proposals`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      data: {
        proposals: [
          {
            id: proposalId,
            title: 'A proposal that will be withdrawn',
            lifecycleState: 'withdrawn',
          },
        ],
      },
    });
  });
});
