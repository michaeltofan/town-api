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
 * Mirrors civic-secret-ballot.integration.test.ts's account setup: 5
 * confirmers + 5 proposal authors (10 accounts, the email-verification IP
 * rate limit), reused as deliberation contributors and voters, driven all
 * the way through a decided mandate (§9's quorum of 5 votes).
 */
describe('civic mandate extensions: minority position and contestation (governance spec §10, §11)', () => {
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
      const confirmer = await makeParticipant(`MandateExtConfirmer${String(i)}`);
      confirmerSessionTokens.push(confirmer.sessionToken);
    }
    authorSessionTokens = [];
    for (let i = 0; i < 5; i += 1) {
      const author = await makeParticipant(`MandateExtAuthor${String(i)}`);
      authorSessionTokens.push(author.sessionToken);
    }
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function driveSignalToDecidedMandate(
    slug: string,
    position: number,
    options: { votingClosesAtOffset: string },
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
          title: `Mandate extensions proposal ${String(index)}`,
          body: `Body for proposal ${String(index)}.`,
          expectedOutcome: `Expected outcome ${String(index)}.`,
        },
      });
      expect(response.statusCode).toBe(201);
      proposalIds.push(response.json<{ data: { id: string } }>().data.id);
    }

    // The 5th deliberation contribution is marked minority_position, so the
    // decided mandate's permanent record has one to surface (§7/§11).
    for (const [index, sessionToken] of confirmerSessionTokens.entries()) {
      const proposalId = proposalIds[index];
      if (proposalId === undefined) throw new Error('expected a proposal id');
      const isLast = index === confirmerSessionTokens.length - 1;
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/v1/signals/${signalId}/civic-process/deliberation/proposals/${proposalId}/contributions`,
        headers: { authorization: `Session ${sessionToken}` },
        payload: {
          intent: isLast ? 'minority_position' : 'observation',
          text: isLast
            ? `A dissenting minority position on proposal ${String(index)}, preserved verbatim.`
            : `A deliberation contribution number ${String(index)} with enough length.`,
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
    expect(processRow.rows[0]?.current_stage).toBe('ballot_preparation');

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
      `UPDATE town.civic_processes SET voting_closes_at = now() - interval '${options.votingClosesAtOffset}' WHERE id = $1`,
      [processId],
    );
    const decided = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/mandate`,
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ data: { decided: true, contested: false } });

    return { signalId, processId, proposalIds };
  }

  it("surfaces the minority position in the decided mandate's permanent record", async () => {
    const { signalId } = await driveSignalToDecidedMandate('mandate-ext-minority-test', 32201, {
      votingClosesAtOffset: '1 second',
    });

    const mandate = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/mandate`,
    });
    expect(mandate.statusCode).toBe(200);
    const body = mandate.json<{
      data: { minorityPositions: { text: string; authorDisplayName: string }[] };
    }>();
    expect(body.data.minorityPositions).toHaveLength(1);
    expect(body.data.minorityPositions[0]?.text).toContain('dissenting minority position');
  });

  it('lets an eligible actor file a contestation, reporting it only to the filer', async () => {
    const { signalId } = await driveSignalToDecidedMandate('mandate-ext-contest-test', 32202, {
      votingClosesAtOffset: '1 second',
    });
    const filerSessionToken = confirmerSessionTokens[0];
    const otherSessionToken = confirmerSessionTokens[1];
    if (filerSessionToken === undefined || otherSessionToken === undefined) {
      throw new Error('expected two session tokens');
    }

    const filed = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/mandate/contest`,
      headers: { authorization: `Session ${filerSessionToken}` },
      payload: { reasonKey: 'count_discrepancy', elaboration: 'The tally looks off by one.' },
    });
    expect(filed.statusCode).toBe(201);
    expect(filed.json()).toMatchObject({
      data: { reasonKey: 'count_discrepancy', status: 'pending' },
    });
    expect(filed.body).not.toMatch(/accountId|actorId/);

    const asFiler = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/mandate`,
      headers: { authorization: `Session ${filerSessionToken}` },
    });
    expect(asFiler.statusCode).toBe(200);
    expect(asFiler.json()).toMatchObject({
      data: {
        contestationPending: true,
        myContestation: { reasonKey: 'count_discrepancy', status: 'pending' },
      },
    });

    const asOther = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/mandate`,
      headers: { authorization: `Session ${otherSessionToken}` },
    });
    expect(asOther.statusCode).toBe(200);
    expect(asOther.json()).toMatchObject({
      data: { contestationPending: true, myContestation: null },
    });

    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/mandate`,
    });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json()).toMatchObject({
      data: { contestationPending: true, myContestation: null },
    });
  });

  it('rejects a second contestation from the same actor', async () => {
    const { signalId } = await driveSignalToDecidedMandate(
      'mandate-ext-duplicate-contest-test',
      32203,
      { votingClosesAtOffset: '1 second' },
    );
    const filerSessionToken = confirmerSessionTokens[2];
    if (filerSessionToken === undefined) throw new Error('expected a session token');

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/mandate/contest`,
      headers: { authorization: `Session ${filerSessionToken}` },
      payload: { reasonKey: 'eligibility_error' },
    });
    expect(first.statusCode).toBe(201);

    const second = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/mandate/contest`,
      headers: { authorization: `Session ${filerSessionToken}` },
      payload: { reasonKey: 'ballot_tampering_suspected' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'CIVIC_CONTESTATION_ALREADY_FILED' } });
  });

  it('rejects a contestation once the 72-hour window has closed', async () => {
    const { signalId } = await driveSignalToDecidedMandate('mandate-ext-window-test', 32204, {
      votingClosesAtOffset: '100 hours',
    });
    const filerSessionToken = confirmerSessionTokens[3];
    if (filerSessionToken === undefined) throw new Error('expected a session token');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/mandate/contest`,
      headers: { authorization: `Session ${filerSessionToken}` },
      payload: { reasonKey: 'count_discrepancy' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CIVIC_CONTESTATION_WINDOW_CLOSED' } });
  });
});
