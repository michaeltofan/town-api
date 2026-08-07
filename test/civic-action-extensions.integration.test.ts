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
 * Mirrors civic-mandate-extensions.integration.test.ts's account setup: 5
 * confirmers + 5 proposal authors, driven all the way through a decided
 * mandate and into the action stage (§9's quorum of 5 votes).
 */
describe('civic action extensions: responsible actor, collaborators, typed updates (governance spec §12)', () => {
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
      const confirmer = await makeParticipant(`ActionExtConfirmer${String(i)}`);
      confirmerSessionTokens.push(confirmer.sessionToken);
    }
    authorSessionTokens = [];
    for (let i = 0; i < 5; i += 1) {
      const author = await makeParticipant(`ActionExtAuthor${String(i)}`);
      authorSessionTokens.push(author.sessionToken);
    }
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function driveSignalIntoAction(
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
          title: `Action extensions proposal ${String(index)}`,
          body: `Body for proposal ${String(index)}.`,
          targetInstitution: 'City Hall',
          expectedOutcome: 'Repave the street within budget.',
          indicativeDeadline: '2026-12-01',
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

    return { signalId, processId };
  }

  it('surfaces target institution, objective, and indicative deadline from the winning proposal', async () => {
    const { signalId } = await driveSignalIntoAction('action-ext-winner-fields-test', 32301);
    const action = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/action`,
    });
    expect(action.statusCode).toBe(200);
    expect(action.json()).toMatchObject({
      data: {
        winner: {
          targetInstitution: 'City Hall',
          objective: 'Repave the street within budget.',
          indicativeDeadline: '2026-12-01',
        },
        actionStatus: 'not_started',
        responsibleActor: null,
        collaborators: [],
      },
    });
  });

  it('lets one actor claim the named responsible-actor role, rejecting a second claim', async () => {
    const { signalId } = await driveSignalIntoAction('action-ext-responsible-test', 32302);
    const claimer = confirmerSessionTokens[0];
    const secondClaimer = confirmerSessionTokens[1];
    if (claimer === undefined || secondClaimer === undefined) {
      throw new Error('expected two session tokens');
    }

    const claim = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/action/updates`,
      headers: { authorization: `Session ${claimer}` },
      payload: { text: 'I will take the lead on this action item.', kind: 'take_step' },
    });
    expect(claim.statusCode).toBe(201);
    expect(claim.json()).toMatchObject({ data: { kind: 'take_step' } });

    const afterClaim = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/action`,
    });
    expect(afterClaim.statusCode).toBe(200);
    expect(
      afterClaim.json<{ data: { responsibleActor: { displayName: string } | null } }>().data
        .responsibleActor,
    ).not.toBeNull();
    expect(afterClaim.json()).toMatchObject({ data: { actionStatus: 'in_progress' } });

    const secondClaim = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/action/updates`,
      headers: { authorization: `Session ${secondClaimer}` },
      payload: { text: 'I would also like to lead this.', kind: 'take_step' },
    });
    expect(secondClaim.statusCode).toBe(409);
    expect(secondClaim.json()).toMatchObject({
      error: { code: 'CIVIC_ACTION_ALREADY_HAS_RESPONSIBLE_ACTOR' },
    });
  });

  it('accumulates distinct collaborators from offer_help updates', async () => {
    const { signalId } = await driveSignalIntoAction('action-ext-collaborators-test', 32303);
    for (const sessionToken of confirmerSessionTokens.slice(0, 2)) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/v1/signals/${signalId}/civic-process/action/updates`,
        headers: { authorization: `Session ${sessionToken}` },
        payload: { text: 'I can help carry materials for this.', kind: 'offer_help' },
      });
      expect(response.statusCode).toBe(201);
    }
    // A duplicate offer_help from the same actor must not double-count.
    const duplicate = confirmerSessionTokens[0];
    if (duplicate === undefined) throw new Error('expected a session token');
    const dup = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/action/updates`,
      headers: { authorization: `Session ${duplicate}` },
      payload: { text: 'Reiterating my offer to help.', kind: 'offer_help' },
    });
    expect(dup.statusCode).toBe(201);

    const action = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/action`,
    });
    expect(action.statusCode).toBe(200);
    const body = action.json<{ data: { collaborators: { actorId: string }[] } }>();
    expect(body.data.collaborators).toHaveLength(2);
  });

  it('reports blocked with a structured reason, then returns to in_progress on the next plain update', async () => {
    const { signalId } = await driveSignalIntoAction('action-ext-blocked-test', 32304);
    const sessionToken = confirmerSessionTokens[0];
    if (sessionToken === undefined) throw new Error('expected a session token');

    const blocked = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/action/updates`,
      headers: { authorization: `Session ${sessionToken}` },
      payload: {
        text: 'Waiting to hear back from the city on permits.',
        kind: 'status_update',
        blockedReasonKey: 'awaiting_institution_response',
      },
    });
    expect(blocked.statusCode).toBe(201);
    expect(blocked.json()).toMatchObject({
      data: { blockedReasonKey: 'awaiting_institution_response' },
    });

    const whileBlocked = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/action`,
    });
    expect(whileBlocked.statusCode).toBe(200);
    expect(whileBlocked.json()).toMatchObject({ data: { actionStatus: 'blocked' } });

    const resumed = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/action/updates`,
      headers: { authorization: `Session ${sessionToken}` },
      payload: { text: 'The city responded, we can proceed now.', kind: 'status_update' },
    });
    expect(resumed.statusCode).toBe(201);

    const afterResume = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/action`,
    });
    expect(afterResume.statusCode).toBe(200);
    expect(afterResume.json()).toMatchObject({ data: { actionStatus: 'in_progress' } });
  });

  it('rejects a blocked reason on a non-status_update kind and a url on a non-evidence kind', async () => {
    const { signalId } = await driveSignalIntoAction('action-ext-invalid-combo-test', 32305);
    const sessionToken = confirmerSessionTokens[0];
    if (sessionToken === undefined) throw new Error('expected a session token');

    const badBlockedReason = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/action/updates`,
      headers: { authorization: `Session ${sessionToken}` },
      payload: {
        text: 'This should not be allowed to carry a blocked reason.',
        kind: 'offer_help',
        blockedReasonKey: 'other',
      },
    });
    expect(badBlockedReason.statusCode).toBe(400);

    const badUrl = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/action/updates`,
      headers: { authorization: `Session ${sessionToken}` },
      payload: {
        text: 'This should not be allowed to carry a url.',
        kind: 'status_update',
        url: 'https://example.com/photo.jpg',
      },
    });
    expect(badUrl.statusCode).toBe(400);
  });

  it('attaches an evidence url on the evidence kind and reports completed once verification opens', async () => {
    const { signalId } = await driveSignalIntoAction('action-ext-evidence-test', 32306);
    const sessionToken = confirmerSessionTokens[0];
    if (sessionToken === undefined) throw new Error('expected a session token');

    const evidence = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/action/updates`,
      headers: { authorization: `Session ${sessionToken}` },
      payload: {
        text: 'Photo of the repaved street.',
        kind: 'evidence',
        url: 'https://example.com/photo.jpg',
      },
    });
    expect(evidence.statusCode).toBe(201);
    expect(evidence.json()).toMatchObject({
      data: { kind: 'evidence', url: 'https://example.com/photo.jpg' },
    });

    const ready = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/civic-process/verification/ready`,
      headers: { authorization: `Session ${sessionToken}` },
    });
    expect(ready.statusCode).toBe(200);

    const afterReady = await ctx.app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/action`,
    });
    expect(afterReady.statusCode).toBe(200);
    expect(afterReady.json()).toMatchObject({
      data: { currentStage: 'verification', actionStatus: 'completed' },
    });
  });
});
