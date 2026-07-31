import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FOUNDATION_SIGNAL_IDS } from '../src/db/seeds/foundation-content.js';
import type { MemberActivityResponse } from '../src/membership/member-activity-schemas.js';
import {
  activatePasskeyAccountAndLinkCommunity,
  activateTestMembership,
  createEligibleTestResolver,
  createMembershipTestApp,
  FOUNDATION_COMMUNITY_IDS,
} from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';

describe('GET /v1/account/activity', () => {
  let ctx: Awaited<ReturnType<typeof createMembershipTestApp>>;

  beforeAll(async () => {
    ctx = await createMembershipTestApp({
      localEligibilityResolver: createEligibleTestResolver(),
    });
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function participantSession(email: string) {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email,
      communityId: FOUNDATION_COMMUNITY_IDS.milanoIt,
    });
    await activateTestMembership(ctx.app, {
      accountId: registration.accountId,
      effectiveAt: '2026-07-17T12:00:00.000Z',
      accessUntil: '2030-01-01T00:00:00.000Z',
    });
    const login = await loginMobileSession({
      app: ctx.app,
      material: registration.material,
    });
    return { registration, login };
  }

  it('rejects missing session', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/account/activity',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
  });

  it('returns empty items when the member has no civic activity yet', async () => {
    const { login } = await participantSession('ActivityEmpty+setup@example.com');
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/account/activity',
      headers: { authorization: `Session ${login.sessionToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<MemberActivityResponse>();
    expect(body.data.items).toEqual([]);
  });

  it('returns real confirmations, contributions, and signal evolution — no invented rows', async () => {
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;
    const { login } = await participantSession('ActivityReal+setup@example.com');

    const confirm = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/signals/${signalId}/confirmation`,
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: {},
    });
    expect(confirm.statusCode).toBe(200);

    const contributionText = 'A concrete observation from the member for Activity.';
    const contribute = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signals/${signalId}/discussion-session/contributions`,
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { text: contributionText, intent: 'observation' },
    });
    expect(contribute.statusCode).toBe(201);

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/account/activity',
      headers: { authorization: `Session ${login.sessionToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<MemberActivityResponse>();
    const kinds = body.data.items.map((item) => item.kind);
    expect(kinds).toContain('confirmation');
    expect(kinds).toContain('contribution');
    expect(kinds).toContain('signal_evolution');

    const confirmation = body.data.items.find((item) => item.kind === 'confirmation');
    expect(confirmation).toMatchObject({
      kind: 'confirmation',
      signal: { id: signalId },
    });
    expect(confirmation?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const contribution = body.data.items.find((item) => item.kind === 'contribution');
    expect(contribution).toMatchObject({
      kind: 'contribution',
      signal: { id: signalId },
      contribution: {
        text: contributionText,
        intent: 'observation',
      },
    });

    const evolution = body.data.items.find((item) => item.kind === 'signal_evolution');
    expect(evolution).toMatchObject({
      kind: 'signal_evolution',
      signal: { id: signalId },
    });
    if (evolution?.kind === 'signal_evolution') {
      expect(evolution.evolution.statusLabel.length).toBeGreaterThan(0);
      expect(evolution.evolution.latestUpdate.length).toBeGreaterThan(0);
    }

    // No demo/example invented kinds.
    expect(
      kinds.every((kind) =>
        ['confirmation', 'contribution', 'signal_published', 'signal_evolution'].includes(kind),
      ),
    ).toBe(true);

    // Other members' activity is never mixed in: only this session's durable rows.
    for (const item of body.data.items) {
      expect(item.signal.id).toBe(signalId);
    }
  });
});
