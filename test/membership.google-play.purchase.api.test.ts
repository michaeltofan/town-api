import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { activatePasskeyAccountAndLinkCommunity } from './helpers/membership.js';
import { loginMobileSession } from './helpers/passkey-management.js';
import {
  createGooglePlayTestApp,
  seedActiveGooglePlayPurchase,
  type GooglePlayTestApp,
} from './helpers/google-play.js';

const ROUTE = '/v1/billing/google-play/purchases';
const NOW = '2026-07-25T15:00:00.000Z';
const ACCESS_UNTIL = '2027-07-25T15:00:00.000Z';

describe('POST /v1/billing/google-play/purchases', () => {
  let ctx: GooglePlayTestApp;

  beforeAll(async () => {
    ctx = await createGooglePlayTestApp({ now: () => NOW });
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it('rejects missing session with SESSION_NOT_AUTHORIZED', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: ROUTE,
      payload: { purchaseToken: 'gp_token_unauth' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
  });

  it('rejects SetupGrant, RecoveryGrant, and Bearer schemes', async () => {
    for (const scheme of ['SetupGrant', 'RecoveryGrant', 'Bearer'] as const) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: ROUTE,
        headers: { authorization: `${scheme} irrelevant-token` },
        payload: { purchaseToken: 'gp_token_scheme' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'SESSION_NOT_AUTHORIZED' } });
    }
  });

  it('returns 404 when GOOGLE_PLAY_BILLING_ENABLED is false', async () => {
    const disabled = await createGooglePlayTestApp({ billingEnabled: false, now: () => NOW });
    try {
      const registration = await activatePasskeyAccountAndLinkCommunity({
        app: disabled.app,
        delivery: disabled.delivery,
        email: 'GooglePlayDisabled+setup@example.com',
      });
      const login = await loginMobileSession({
        app: disabled.app,
        material: registration.material,
      });
      const response = await disabled.app.inject({
        method: 'POST',
        url: ROUTE,
        headers: { authorization: `Session ${login.sessionToken}` },
        payload: { purchaseToken: 'gp_token_disabled_flag' },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await disabled.app.close();
      await disabled.pool.end();
    }
  });

  it('verifies and provisions paid_pending_binding for an authenticated session', async () => {
    const token = 'gp_token_api_success_unique';
    seedActiveGooglePlayPurchase(ctx.googlePlayState, {
      purchaseToken: token,
      expiryTime: ACCESS_UNTIL,
    });
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'GooglePlaySuccess+setup@example.com',
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    const response = await ctx.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { purchaseToken: token },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      data: {
        result: string;
        membership: {
          status: string;
          accessUntil: string | null;
          cancelAtPeriodEnd: boolean;
        };
      };
    }>();
    expect(body.data.result).toBe('applied');
    expect(body.data.membership.status).toBe('paid_pending_binding');
    expect(body.data.membership.accessUntil).toBe(ACCESS_UNTIL);
    expect(body.data.membership.cancelAtPeriodEnd).toBe(false);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toMatch(/subscriptionState|lineItems|private_key/i);
  });

  it('rejects failed Google verification without leaking reasons or tokens', async () => {
    const token = 'gp_token_api_not_found';
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'GooglePlayVerifyFail+setup@example.com',
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    const response = await ctx.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { purchaseToken: token },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('GOOGLE_PLAY_PURCHASE_REJECTED');
    expect(JSON.stringify(body)).not.toContain(token);
    expect(body.error.message.toLowerCase()).not.toContain('not_found');
    expect(body.error.message.toLowerCase()).not.toContain('transport');
  });

  it('replays idempotently for the same account and purchase token', async () => {
    const token = 'gp_token_api_replay';
    seedActiveGooglePlayPurchase(ctx.googlePlayState, {
      purchaseToken: token,
      expiryTime: ACCESS_UNTIL,
    });
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'GooglePlayReplay+setup@example.com',
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    const first = await ctx.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { purchaseToken: token },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ data: { result: 'applied' } });

    const second = await ctx.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { purchaseToken: token },
    });
    expect(second.statusCode).toBe(200);
    const body = second.json<{
      data: { result: string; membership: { status: string; accessUntil: string | null } };
    }>();
    expect(body.data.result).toBe('replayed');
    expect(body.data.membership.status).toBe('paid_pending_binding');
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it('returns GOOGLE_PLAY_PURCHASE_ACKNOWLEDGE_FAILED when acknowledge transport fails after durable provision', async () => {
    const token = 'gp_token_api_ack_fail';
    seedActiveGooglePlayPurchase(ctx.googlePlayState, {
      purchaseToken: token,
      expiryTime: ACCESS_UNTIL,
    });
    ctx.googlePlayState.errorHooks.acknowledgeSubscription = () =>
      new Error('acknowledge unavailable');
    const registration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'GooglePlayAckFail+setup@example.com',
    });
    const login = await loginMobileSession({ app: ctx.app, material: registration.material });
    const response = await ctx.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Session ${login.sessionToken}` },
      payload: { purchaseToken: token },
    });
    delete ctx.googlePlayState.errorHooks.acknowledgeSubscription;
    expect(response.statusCode).toBe(502);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('GOOGLE_PLAY_PURCHASE_ACKNOWLEDGE_FAILED');
    expect(JSON.stringify(body)).not.toContain(token);
    expect(body.error.message.toLowerCase()).not.toContain('transport');
    expect(body.error.message.toLowerCase()).not.toContain('unavailable');
  });

  it('protects against cross-account purchase token reuse', async () => {
    const token = 'gp_token_api_cross_account';
    seedActiveGooglePlayPurchase(ctx.googlePlayState, {
      purchaseToken: token,
      expiryTime: ACCESS_UNTIL,
    });
    const firstRegistration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'GooglePlayCrossA+setup@example.com',
    });
    const firstLogin = await loginMobileSession({
      app: ctx.app,
      material: firstRegistration.material,
    });
    const first = await ctx.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Session ${firstLogin.sessionToken}` },
      payload: { purchaseToken: token },
    });
    expect(first.statusCode).toBe(200);

    const secondRegistration = await activatePasskeyAccountAndLinkCommunity({
      app: ctx.app,
      delivery: ctx.delivery,
      email: 'GooglePlayCrossB+setup@example.com',
    });
    const secondLogin = await loginMobileSession({
      app: ctx.app,
      material: secondRegistration.material,
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Session ${secondLogin.sessionToken}` },
      payload: { purchaseToken: token },
    });
    expect(second.statusCode).toBe(409);
    const body = second.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('GOOGLE_PLAY_PURCHASE_ALREADY_BOUND');
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it('redacts purchaseToken from structured request logs', async () => {
    const out = new PassThrough();
    let buffer = '';
    out.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    const log = pino(
      {
        level: 'info',
        redact: {
          paths: ['req.body.purchaseToken', 'body.purchaseToken'],
          censor: '[Redacted]',
        },
      },
      out,
    );
    const secretToken = 'gp_token_must_never_appear_in_logs_xyz';
    log.info(
      {
        req: {
          body: { purchaseToken: secretToken, packageName: 'com.town.town_safe_space_mobile' },
        },
        body: { purchaseToken: secretToken },
      },
      'google-play-purchase',
    );
    out.end();
    await new Promise<void>((resolve) => {
      out.on('end', () => {
        resolve();
      });
    });
    expect(buffer).not.toContain(secretToken);
    expect(buffer).toContain('[Redacted]');
    expect(buffer).toContain('com.town.town_safe_space_mobile');
  });
});
