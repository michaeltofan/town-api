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
 * Reaching deliberation needs 5 confirmers (confirmation threshold) plus 5
 * distinct proposal authors (one proposal per actor per process, 5 needed to
 * cross the proposal threshold) — 10 accounts, exactly the email-verification
 * IP rate limit (10 / 15 minutes, see src/ceremony/email-verification/policy.ts).
 * Those same 10 accounts are reused as deliberation contributors below since
 * nothing in the governance spec prevents a confirmer or proposal author from
 * also contributing to deliberation.
 */
describe('civic deliberation extended intents and reply threading (governance spec §7)', () => {
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
      const confirmer = await makeParticipant(`DeliberationConfirmer${String(i)}`);
      confirmerSessionTokens.push(confirmer.sessionToken);
    }
    authorSessionTokens = [];
    for (let i = 0; i < 5; i += 1) {
      const author = await makeParticipant(`DeliberationAuthor${String(i)}`);
      authorSessionTokens.push(author.sessionToken);
    }
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function driveSignalToDeliberation(
    slug: string,
    position: number,
  ): Promise<{ signalId: string; proposalIds: string[] }> {
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
          title: `Deliberation proposal ${String(index)}`,
          body: `Body for proposal ${String(index)}.`,
          expectedOutcome: `Expected outcome ${String(index)}.`,
        },
      });
      expect(response.statusCode).toBe(201);
      proposalIds.push(response.json<{ data: { id: string } }>().data.id);
    }

    const stage = await ctx.pool.query<{ current_stage: string }>(
      'SELECT current_stage FROM town.civic_processes WHERE signal_id = $1',
      [signalId],
    );
    expect(stage.rows[0]?.current_stage).toBe('deliberation');
    return { signalId, proposalIds };
  }

  async function postContribution(
    signalId: string,
    proposalId: string,
    sessionToken: string,
    body: Record<string, unknown>,
  ) {
    return ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/deliberation/proposals/${proposalId}/contributions`,
      headers: { authorization: `Session ${sessionToken}` },
      payload: body,
    });
  }

  it('accepts the original three intents (regression)', async () => {
    const { signalId, proposalIds } = await driveSignalToDeliberation(
      'civic-deliberation-original-intents-test',
      32201,
    );
    const proposalId = proposalIds[0];
    if (proposalId === undefined) throw new Error('expected a proposal id');

    for (const [index, intent] of ['observation', 'proposal', 'next_step'].entries()) {
      const sessionToken = confirmerSessionTokens[index];
      if (sessionToken === undefined) throw new Error('expected a confirmer session token');
      const response = await postContribution(signalId, proposalId, sessionToken, {
        intent,
        text: `A contribution with intent ${intent} and enough length.`,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ data: { contribution: { intent } } });
    }
  });

  it('accepts the seven newly extended intents', async () => {
    const { signalId, proposalIds } = await driveSignalToDeliberation(
      'civic-deliberation-extended-intents-test',
      32202,
    );
    const proposalId = proposalIds[0];
    if (proposalId === undefined) throw new Error('expected a proposal id');

    const extendedIntents = [
      'argument_for',
      'risk_or_objection',
      'question',
      'author_response',
      'evidence',
      'amendment_suggestion',
      'minority_position',
    ] as const;
    // The deliberation stage auto-advances once 5 *distinct* actors have
    // contributed (transitionRule.type === 'deliberation_participation_count',
    // requiredParticipants: 5 — see civic-process.integration.test.ts). Reusing
    // a single actor across all seven intents keeps this test focused on
    // intent-vocabulary acceptance without tripping that stage transition.
    const sessionToken = confirmerSessionTokens[0];
    if (sessionToken === undefined) throw new Error('expected a contributor session token');

    for (const intent of extendedIntents) {
      const response = await postContribution(signalId, proposalId, sessionToken, {
        intent,
        text: `A contribution with intent ${intent} and enough length to pass.`,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ data: { contribution: { intent } } });
    }
  });

  it('rejects an unsupported intent value', async () => {
    const { signalId, proposalIds } = await driveSignalToDeliberation(
      'civic-deliberation-invalid-intent-test',
      32203,
    );
    const proposalId = proposalIds[0];
    const sessionToken = confirmerSessionTokens[0];
    if (proposalId === undefined || sessionToken === undefined) {
      throw new Error('expected a proposal id and session token');
    }

    const response = await postContribution(signalId, proposalId, sessionToken, {
      intent: 'not_a_real_intent',
      text: 'This should be rejected by schema validation.',
    });
    expect(response.statusCode).toBe(400);
  });

  it('threads a reply to a contribution and exposes replyToContributionId on read', async () => {
    const { signalId, proposalIds } = await driveSignalToDeliberation(
      'civic-deliberation-reply-thread-test',
      32204,
    );
    const proposalId = proposalIds[0];
    const rootSessionToken = confirmerSessionTokens[0];
    const replySessionToken = confirmerSessionTokens[1];
    if (
      proposalId === undefined ||
      rootSessionToken === undefined ||
      replySessionToken === undefined
    ) {
      throw new Error('expected a proposal id and two session tokens');
    }

    const root = await postContribution(signalId, proposalId, rootSessionToken, {
      intent: 'observation',
      text: 'A root-level observation contribution for threading.',
    });
    expect(root.statusCode).toBe(201);
    const rootContributionId = root.json<{ data: { contribution: { id: string } } }>().data
      .contribution.id;

    const reply = await postContribution(signalId, proposalId, replySessionToken, {
      intent: 'author_response',
      text: 'A reply that threads directly under the root contribution.',
      replyToContributionId: rootContributionId,
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json()).toMatchObject({
      data: { contribution: { replyToContributionId: rootContributionId } },
    });

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/deliberation`,
    });
    expect(read.statusCode).toBe(200);
    const proposal = read
      .json<{
        data: {
          proposals: {
            id: string;
            contributions: { id: string; replyToContributionId: string | null }[];
          }[];
        };
      }>()
      .data.proposals.find((candidate) => candidate.id === proposalId);
    expect(proposal?.contributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: rootContributionId, replyToContributionId: null }),
        expect.objectContaining({
          id: reply.json<{ data: { contribution: { id: string } } }>().data.contribution.id,
          replyToContributionId: rootContributionId,
        }),
      ]),
    );
  });

  it('rejects a reply that targets a contribution under a different proposal', async () => {
    const { signalId, proposalIds } = await driveSignalToDeliberation(
      'civic-deliberation-cross-proposal-reply-test',
      32205,
    );
    const proposalA = proposalIds[0];
    const proposalB = proposalIds[1];
    const sessionTokenA = confirmerSessionTokens[0];
    const sessionTokenB = confirmerSessionTokens[1];
    if (
      proposalA === undefined ||
      proposalB === undefined ||
      sessionTokenA === undefined ||
      sessionTokenB === undefined
    ) {
      throw new Error('expected two proposal ids and two session tokens');
    }

    const rootOnA = await postContribution(signalId, proposalA, sessionTokenA, {
      intent: 'observation',
      text: 'A root-level observation contribution under proposal A.',
    });
    expect(rootOnA.statusCode).toBe(201);
    const rootOnAId = rootOnA.json<{ data: { contribution: { id: string } } }>().data.contribution
      .id;

    const crossReply = await postContribution(signalId, proposalB, sessionTokenB, {
      intent: 'question',
      text: 'A reply posted under proposal B pointing at a contribution on proposal A.',
      replyToContributionId: rootOnAId,
    });
    expect(crossReply.statusCode).toBe(400);
    expect(crossReply.json()).toMatchObject({
      error: { code: 'CIVIC_DELIBERATION_INVALID_REPLY_TARGET' },
    });
  });

  it('rejects a reply targeting a nonexistent contribution id', async () => {
    const { signalId, proposalIds } = await driveSignalToDeliberation(
      'civic-deliberation-missing-reply-target-test',
      32206,
    );
    const proposalId = proposalIds[0];
    const sessionToken = confirmerSessionTokens[0];
    if (proposalId === undefined || sessionToken === undefined) {
      throw new Error('expected a proposal id and session token');
    }

    const response = await postContribution(signalId, proposalId, sessionToken, {
      intent: 'observation',
      text: 'A contribution replying to a contribution that does not exist.',
      replyToContributionId: randomUUID(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'CIVIC_DELIBERATION_INVALID_REPLY_TARGET' },
    });
  });
});
