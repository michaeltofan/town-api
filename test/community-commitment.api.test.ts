import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { actors } from '../src/db/schema.js';
import { FOUNDATION_COMMUNITY_IDS } from '../src/db/seeds/foundation-content.js';
import { COMMUNITY_COMMITMENT_VERSION } from '../src/membership/community-commitment.js';
import {
  activatePasskeyAccountAndLinkCommunity,
  activateTestMembership,
  createMembershipTestApp,
  recordLinkedCivicActorCommunityCommitment,
  setLinkedCivicActorCommunity,
  type MembershipTestApp,
} from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';

describe('GET/PUT /v1/account/community-commitment', () => {
  let ctx: MembershipTestApp;

  beforeAll(async () => {
    ctx = await createMembershipTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it('rejects missing session on read with SESSION_NOT_AUTHORIZED', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/account/community-commitment',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
  });

  it('rejects missing session on write with SESSION_NOT_AUTHORIZED', async () => {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/account/community-commitment',
      payload: { community: 'milano-it', accepted: true },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
  });

  it('rejects SetupGrant, RecoveryGrant, and Bearer schemes on write', async () => {
    for (const scheme of ['SetupGrant', 'RecoveryGrant', 'Bearer'] as const) {
      const response = await ctx.app.inject({
        method: 'PUT',
        url: '/v1/account/community-commitment',
        headers: { authorization: `${scheme} irrelevant-token` },
        payload: { community: 'milano-it', accepted: true },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
    }
  });

  it('rejects missing or non-true acceptance', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'CommitmentAcceptRequired+setup@example.com',
      linkCommunity: false,
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });

    const missing = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/account/community-commitment',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'milano-it' },
    });
    expect(missing.statusCode).toBe(400);

    const falseAccept = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/account/community-commitment',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'milano-it', accepted: false },
    });
    expect(falseAccept.statusCode).toBe(400);
  });

  it('rejects unsupported community slug', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'CommitmentUnknownCommunity+setup@example.com',
      linkCommunity: false,
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    const response = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/account/community-commitment',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'not-a-real-community', accepted: true },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'COMMUNITY_NOT_FOUND' } });
  });

  it('records a valid commitment with community derived country/city, server timestamp and version', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'CommitmentHappy+setup@example.com',
      linkCommunity: false,
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    const response = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/account/community-commitment',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'munich-de', accepted: true },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      data: {
        status: string;
        accepted: boolean;
        acceptedAt: string;
        commitmentVersion: string;
        editable: boolean;
        community: {
          slug: string;
          countryCode: string;
          cityName: string;
          displayName: string;
        };
      };
    }>();
    expect(body.data.status).toBe('recorded');
    expect(body.data.accepted).toBe(true);
    expect(body.data.commitmentVersion).toBe(COMMUNITY_COMMITMENT_VERSION);
    expect(body.data.editable).toBe(true);
    expect(body.data.community).toMatchObject({
      slug: 'munich-de',
      countryCode: 'DE',
      cityName: 'Munich',
    });
    expect(body.data.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const rows = await ctx.app.database.db
      .select()
      .from(actors)
      .where(eq(actors.accountId, registration.accountId))
      .limit(1);
    expect(rows[0]?.localEligibilityVerifiedAt).toBeNull();
    expect(rows[0]?.communityCommitmentVersion).toBe(COMMUNITY_COMMITMENT_VERSION);
  });

  it('is idempotent for an identical repeated submission', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'CommitmentIdempotent+setup@example.com',
      linkCommunity: false,
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    const first = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/account/community-commitment',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'arad-ro', accepted: true },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ data: { acceptedAt: string } }>();

    const second = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/account/community-commitment',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'arad-ro', accepted: true },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<{ data: { acceptedAt: string } }>();
    expect(secondBody.data.acceptedAt).toBe(firstBody.data.acceptedAt);
  });

  it('treats existing community association without acceptance as none', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'CommitmentNoAccept+setup@example.com',
      linkCommunity: false,
    });
    await setLinkedCivicActorCommunity(ctx.app, {
      accountId: registration.accountId,
      communityId: FOUNDATION_COMMUNITY_IDS.milanoIt,
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/v1/account/community-commitment',
      headers: { authorization: `Session ${login.sessionToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        status: 'none',
        accepted: false,
        community: null,
        commitmentVersion: null,
      },
    });
  });

  it('locks community change once paid membership is active', async () => {
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'CommitmentLocked+setup@example.com',
      linkCommunity: false,
    });
    await recordLinkedCivicActorCommunityCommitment(ctx.app, {
      accountId: registration.accountId,
      communityId: FOUNDATION_COMMUNITY_IDS.milanoIt,
    });
    await activateTestMembership(ctx.app, {
      accountId: registration.accountId,
      effectiveAt: '2026-07-01T00:00:00.000Z',
      accessUntil: '2027-07-01T00:00:00.000Z',
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    const response = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/account/community-commitment',
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { community: 'munich-de', accepted: true },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'COMMUNITY_COMMITMENT_LOCKED' } });
  });
});
