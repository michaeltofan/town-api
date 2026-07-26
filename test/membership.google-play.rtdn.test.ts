import { PassThrough } from 'node:stream';
import { LoginTicket, type TokenPayload } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type AppInstance } from '../src/app.js';
import {
  parseRtdnNotification,
  RtdnParseError,
} from '../src/membership/google-play/rtdn/parse-notification.js';
import {
  createPubSubPushVerifier,
  PubSubPushAuthenticationError,
  PubSubPushVerifierUnavailableError,
  type PubSubPushVerifier,
} from '../src/membership/google-play/rtdn/verify-pubsub-push.js';
import { createFakeDatabase } from './helpers/database.js';
import { createTestEnv } from './helpers/env.js';

const ROUTE = '/v1/billing/google-play/rtdn';
const PACKAGE_NAME = 'org.town.test';
const SUBSCRIPTION = 'projects/town-test/subscriptions/google-play-rtdn';
const AUDIENCE = 'https://api.example.test/v1/billing/google-play/rtdn';
const SERVICE_ACCOUNT = 'pubsub-push@town-test.iam.gserviceaccount.com';
const JWT = 'jwt-secret-that-must-never-be-logged';
const PURCHASE_TOKEN = 'purchase-token-that-must-never-be-logged';

const ENABLED_ENV = {
  GOOGLE_PLAY_RTDN_INGRESS_ENABLED: 'true',
  GOOGLE_PLAY_RTDN_OIDC_AUDIENCE: AUDIENCE,
  GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
  GOOGLE_PLAY_RTDN_PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
  GOOGLE_PLAY_PACKAGE_NAME: PACKAGE_NAME,
} as const;

function pushEnvelope(notification: Record<string, unknown>) {
  return {
    message: {
      messageId: 'message-123',
      data: Buffer.from(JSON.stringify(notification), 'utf8').toString('base64'),
    },
    subscription: SUBSCRIPTION,
  };
}

function testNotification() {
  return {
    version: '1.0',
    packageName: PACKAGE_NAME,
    eventTimeMillis: '1785042000000',
    testNotification: { version: '1.0' },
  };
}

function subscriptionNotification() {
  return {
    version: '1.0',
    packageName: PACKAGE_NAME,
    eventTimeMillis: '1785042000000',
    subscriptionNotification: {
      version: '1.0',
      notificationType: 2,
      purchaseToken: PURCHASE_TOKEN,
    },
  };
}

async function createRtdnApp(input: {
  verifier: PubSubPushVerifier;
  enabled?: boolean;
  logger?: false | Record<string, unknown>;
  androidPublisher?: {
    getSubscriptionV2: ReturnType<typeof vi.fn>;
    acknowledgeSubscription: ReturnType<typeof vi.fn>;
  };
}): Promise<AppInstance> {
  const env = createTestEnv(input.enabled === false ? {} : ENABLED_ENV);
  const app = await buildApp({
    env,
    logger: input.logger ?? false,
    database: createFakeDatabase(),
    googlePlayRtdn: { verifier: input.verifier },
    ...(input.androidPublisher ? { googlePlayAdapter: input.androidPublisher } : {}),
  });
  await app.ready();
  return app;
}

describe('Google Play RTDN fail-closed configuration', () => {
  it('defaults the ingress feature flag to false independently of Play billing', () => {
    const env = createTestEnv({ GOOGLE_PLAY_BILLING_ENABLED: 'false' });
    expect(env.GOOGLE_PLAY_RTDN_INGRESS_ENABLED).toBe(false);
  });

  it.each([
    ['missing audience', { ...ENABLED_ENV, GOOGLE_PLAY_RTDN_OIDC_AUDIENCE: undefined }],
    ['audience query', { ...ENABLED_ENV, GOOGLE_PLAY_RTDN_OIDC_AUDIENCE: `${AUDIENCE}?secret=no` }],
    [
      'audience fragment',
      { ...ENABLED_ENV, GOOGLE_PLAY_RTDN_OIDC_AUDIENCE: `${AUDIENCE}#fragment` },
    ],
    [
      'audience wildcard',
      { ...ENABLED_ENV, GOOGLE_PLAY_RTDN_OIDC_AUDIENCE: 'https://*.example.test/rtdn' },
    ],
    [
      'invalid service account email',
      { ...ENABLED_ENV, GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT_EMAIL: 'not-an-email' },
    ],
    [
      'invalid subscription',
      { ...ENABLED_ENV, GOOGLE_PLAY_RTDN_PUBSUB_SUBSCRIPTION: 'town-test/rtdn' },
    ],
    ['missing package', { ...ENABLED_ENV, GOOGLE_PLAY_PACKAGE_NAME: undefined }],
  ])('rejects %s at startup', (_name, overrides) => {
    expect(() => createTestEnv(overrides)).toThrow(/Invalid environment configuration/);
  });
});

describe('Google Pub/Sub OIDC verifier', () => {
  const validClaims = {
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    sub: 'pubsub-push-subject',
    email: SERVICE_ACCOUNT,
    email_verified: true,
    iat: 1_785_042_000,
    exp: 1_785_045_600,
  } satisfies TokenPayload;

  function verifierFor(claims: Partial<TokenPayload>) {
    const verifyIdToken = vi
      .fn()
      .mockResolvedValue(new LoginTicket('test-envelope', claims as TokenPayload));
    return {
      verifier: createPubSubPushVerifier(
        { audience: AUDIENCE, serviceAccountEmail: SERVICE_ACCOUNT },
        { verifyIdToken },
      ),
      verifyIdToken,
    };
  }

  it('accepts the exact Google issuer, audience, service account, and verified email', async () => {
    const { verifier, verifyIdToken } = verifierFor(validClaims);
    await expect(verifier(JWT)).resolves.toBeUndefined();
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: JWT, audience: AUDIENCE });
  });

  it.each([
    ['issuer', { ...validClaims, iss: 'https://issuer.example' }],
    ['audience', { ...validClaims, aud: `${AUDIENCE}/wrong` }],
    ['service account', { ...validClaims, email: 'wrong@example.test' }],
    ['unverified email', { ...validClaims, email_verified: false }],
    [
      'missing iat',
      {
        iss: validClaims.iss,
        aud: validClaims.aud,
        sub: validClaims.sub,
        email: validClaims.email,
        email_verified: validClaims.email_verified,
        exp: validClaims.exp,
      },
    ],
    [
      'missing exp',
      {
        iss: validClaims.iss,
        aud: validClaims.aud,
        sub: validClaims.sub,
        email: validClaims.email,
        email_verified: validClaims.email_verified,
        iat: validClaims.iat,
      },
    ],
  ])('rejects a token with an invalid %s claim', async (_name, claims) => {
    const { verifier } = verifierFor(claims);
    await expect(verifier(JWT)).rejects.toBeInstanceOf(PubSubPushAuthenticationError);
  });

  it('maps Google key-fetch transport failure to verifier unavailable', async () => {
    const verifyIdToken = vi.fn().mockRejectedValue(
      Object.assign(new Error('fetch failed'), {
        code: 'ETIMEDOUT',
      }),
    );
    const verifier = createPubSubPushVerifier(
      { audience: AUDIENCE, serviceAccountEmail: SERVICE_ACCOUNT },
      { verifyIdToken },
    );
    await expect(verifier(JWT)).rejects.toBeInstanceOf(PubSubPushVerifierUnavailableError);
  });
});

describe('Google Play RTDN parse boundary', () => {
  it('extracts only subscription correlation fields and does not require subscriptionId', () => {
    const parsed = parseRtdnNotification(
      Buffer.from(JSON.stringify(pushEnvelope(subscriptionNotification())), 'utf8'),
      { packageName: PACKAGE_NAME, subscription: SUBSCRIPTION },
    );
    expect(parsed).toEqual({
      kind: 'subscription',
      messageId: 'message-123',
      eventTimeMillis: '1785042000000',
      notificationType: 2,
      purchaseToken: PURCHASE_TOKEN,
    });
    expect(parsed).not.toHaveProperty('subscriptionId');
  });

  it.each([
    ['malformed envelope', { nope: true }],
    [
      'wrong subscription',
      { ...pushEnvelope(testNotification()), subscription: 'projects/wrong/subscriptions/wrong' },
    ],
    [
      'invalid base64',
      {
        ...pushEnvelope(testNotification()),
        message: { messageId: 'message-123', data: '**not-base64**' },
      },
    ],
    [
      'invalid decoded JSON',
      {
        ...pushEnvelope(testNotification()),
        message: {
          messageId: 'message-123',
          data: Buffer.from('{', 'utf8').toString('base64'),
        },
      },
    ],
    ['wrong version', pushEnvelope({ ...testNotification(), version: '2.0' })],
    ['wrong package', pushEnvelope({ ...testNotification(), packageName: 'org.town.wrong' })],
    ['non-decimal event time', pushEnvelope({ ...testNotification(), eventTimeMillis: '1.5' })],
    [
      'multiple variants',
      pushEnvelope({
        ...testNotification(),
        subscriptionNotification: subscriptionNotification().subscriptionNotification,
      }),
    ],
    [
      'subscription with subscriptionId',
      pushEnvelope({
        ...subscriptionNotification(),
        subscriptionNotification: {
          ...subscriptionNotification().subscriptionNotification,
          subscriptionId: 'must-not-be-accepted-or-required',
        },
      }),
    ],
  ])('rejects %s', (_name, envelope) => {
    expect(() =>
      parseRtdnNotification(Buffer.from(JSON.stringify(envelope), 'utf8'), {
        packageName: PACKAGE_NAME,
        subscription: SUBSCRIPTION,
      }),
    ).toThrow(RtdnParseError);
  });
});

describe('POST /v1/billing/google-play/rtdn', () => {
  const apps: AppInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it('returns the standard 404 when the independent feature flag is off', async () => {
    const verifier = vi.fn<PubSubPushVerifier>();
    const app = await createRtdnApp({ verifier, enabled: false });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: pushEnvelope(testNotification()),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(verifier).not.toHaveBeenCalled();
  });

  it.each([
    ['missing header', undefined],
    ['wrong scheme', 'Basic credentials'],
    ['empty bearer', 'Bearer '],
    ['bearer with whitespace', 'Bearer token with-space'],
  ])('returns 401 for %s without parsing the malformed body', async (_name, authorization) => {
    const verifier = vi.fn<PubSubPushVerifier>();
    const app = await createRtdnApp({ verifier });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      ...(authorization ? { headers: { authorization } } : {}),
      payload: Buffer.from('{not-json', 'utf8'),
      headers: {
        ...(authorization ? { authorization } : {}),
        'content-type': 'application/json',
      },
    });
    expect(response.statusCode).toBe(401);
    expect(verifier).not.toHaveBeenCalled();
  });

  it('returns 401 when the injected verifier rejects authentication', async () => {
    const verifier = vi
      .fn<PubSubPushVerifier>()
      .mockRejectedValue(new PubSubPushAuthenticationError());
    const app = await createRtdnApp({ verifier });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Bearer ${JWT}` },
      payload: pushEnvelope(testNotification()),
    });
    expect(response.statusCode).toBe(401);
    expect(verifier).toHaveBeenCalledWith(JWT);
  });

  it('returns 503 when the injected verifier reports key-fetch unavailability', async () => {
    const verifier = vi
      .fn<PubSubPushVerifier>()
      .mockRejectedValue(new PubSubPushVerifierUnavailableError());
    const app = await createRtdnApp({ verifier });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Bearer ${JWT}` },
      payload: pushEnvelope(testNotification()),
    });
    expect(response.statusCode).toBe(503);
  });

  it('returns 400 after successful authentication for malformed RTDN', async () => {
    const verifier = vi.fn<PubSubPushVerifier>().mockResolvedValue();
    const app = await createRtdnApp({ verifier });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      headers: {
        authorization: `Bearer ${JWT}`,
        'content-type': 'application/json',
      },
      payload: Buffer.from('{not-json', 'utf8'),
    });
    expect(response.statusCode).toBe(400);
    expect(verifier).toHaveBeenCalledWith(JWT);
  });

  it('acknowledges a valid test notification with 204', async () => {
    const verifier = vi.fn<PubSubPushVerifier>().mockResolvedValue();
    const app = await createRtdnApp({ verifier });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Bearer ${JWT}` },
      payload: pushEnvelope(testNotification()),
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });

  it('returns 503 for a real notification without DB or Android Publisher access', async () => {
    const verifier = vi.fn<PubSubPushVerifier>().mockResolvedValue();
    const getSubscriptionV2 = vi.fn();
    const acknowledgeSubscription = vi.fn();
    const app = await createRtdnApp({
      verifier,
      androidPublisher: { getSubscriptionV2, acknowledgeSubscription },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Bearer ${JWT}` },
      payload: pushEnvelope(subscriptionNotification()),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'GOOGLE_PLAY_RTDN_RETRY_REQUIRED' } });
    expect(getSubscriptionV2).not.toHaveBeenCalled();
    expect(acknowledgeSubscription).not.toHaveBeenCalled();
  });

  it('logs only bounded correlation metadata', async () => {
    const output = new PassThrough();
    let logs = '';
    output.on('data', (chunk: Buffer | string) => {
      logs += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    const verifier = vi.fn<PubSubPushVerifier>().mockResolvedValue();
    const app = await createRtdnApp({
      verifier,
      logger: { level: 'info', stream: output },
    });
    apps.push(app);
    const envelope = pushEnvelope(subscriptionNotification());
    const encodedPayload = envelope.message.data;
    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Bearer ${JWT}` },
      payload: envelope,
    });
    expect(response.statusCode).toBe(503);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(logs).not.toContain(JWT);
    expect(logs).not.toContain(PURCHASE_TOKEN);
    expect(logs).not.toContain(encodedPayload);
    expect(logs).toContain('message-123');
    expect(logs).toContain('google_play_rtdn_real_received_without_durable_sink');
  });
});
