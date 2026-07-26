import { PassThrough } from 'node:stream';
import { LoginTicket, type TokenPayload } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type AppInstance } from '../src/app.js';
import {
  parseRtdnNotification,
  RtdnParseError,
} from '../src/membership/google-play/rtdn/parse-notification.js';
import type {
  GooglePlayRtdnInboxPersister,
  GooglePlayRtdnInboxRecord,
} from '../src/membership/google-play/rtdn/inbox.js';
import { persistGooglePlayRtdnInbox } from '../src/membership/google-play/rtdn/inbox.js';
import type { Database } from '../src/db/client.js';
import {
  googlePlayPurchaseLinks,
  googlePlayRtdnInbox,
  membershipEntitlements,
  membershipSourceEvents,
} from '../src/db/schema.js';
import {
  createPubSubPushVerifier,
  GOOGLE_OIDC_CLOCK_SKEW_SECONDS,
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

function oneTimeNotification() {
  return {
    version: '1.0',
    packageName: PACKAGE_NAME,
    eventTimeMillis: '1785042000000',
    oneTimeProductNotification: {
      version: '1.0',
      notificationType: 1,
      purchaseToken: PURCHASE_TOKEN,
      sku: 'town_one_time',
    },
  };
}

function voidedNotification() {
  return {
    version: '1.0',
    packageName: PACKAGE_NAME,
    eventTimeMillis: '1785042000000',
    voidedPurchaseNotification: {
      purchaseToken: PURCHASE_TOKEN,
      orderId: 'GPA.1234-5678-9012-34567',
      productType: 1,
      refundType: 1,
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
  persistInbox?: GooglePlayRtdnInboxPersister;
}): Promise<AppInstance> {
  const env = createTestEnv(input.enabled === false ? {} : ENABLED_ENV);
  const app = await buildApp({
    env,
    logger: input.logger ?? false,
    database: createFakeDatabase(),
    googlePlayRtdn: {
      verifier: input.verifier,
      ...(input.persistInbox ? { persistInbox: input.persistInbox } : {}),
    },
    ...(input.androidPublisher ? { googlePlayAdapter: input.androidPublisher } : {}),
  });
  await app.ready();
  return app;
}

function createInMemoryInbox() {
  const rows = new Map<string, GooglePlayRtdnInboxRecord>();
  const persistInbox = vi.fn<GooglePlayRtdnInboxPersister>(async (record) => {
    const key = `${record.pubsubSubscription}\0${record.messageId}`;
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, record);
      return 'inserted';
    }
    return existing.payloadHash === record.payloadHash ? 'replayed' : 'conflict';
  });
  return { rows, persistInbox };
}

describe('Google Play RTDN fail-closed configuration', () => {
  it('defaults the ingress feature flag to false independently of Play billing', () => {
    const env = createTestEnv({
      GOOGLE_PLAY_BILLING_ENABLED: 'true',
      GOOGLE_PLAY_PACKAGE_NAME: PACKAGE_NAME,
      GOOGLE_PLAY_SUBSCRIPTION_ID: 'town_annual',
      GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'play-api@town-test.iam.gserviceaccount.com',
        private_key:
          '-----BEGIN PRIVATE KEY-----\nlocal-test-placeholder-private-key\n-----END PRIVATE KEY-----',
      }),
    });
    expect(env.GOOGLE_PLAY_BILLING_ENABLED).toBe(true);
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

  it('pins the documented google-auth-library clock skew', () => {
    expect(GOOGLE_OIDC_CLOCK_SKEW_SECONDS).toBe(300);
  });

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
  it('extracts subscription correlation fields and does not require subscriptionId', () => {
    const parsed = parseRtdnNotification(
      Buffer.from(JSON.stringify(pushEnvelope(subscriptionNotification())), 'utf8'),
      { packageName: PACKAGE_NAME, subscription: SUBSCRIPTION },
    );
    expect(parsed).toMatchObject({
      kind: 'subscription',
      messageId: 'message-123',
      eventTimeMillis: '1785042000000',
      notificationType: 2,
      purchaseToken: PURCHASE_TOKEN,
      subscriptionId: null,
    });
    expect(parsed.rawPayload).toEqual(subscriptionNotification());
    expect(parsed.decodedPayloadBytes).toEqual(
      Buffer.from(JSON.stringify(subscriptionNotification()), 'utf8'),
    );
  });

  it('validates and extracts an optional subscriptionId', () => {
    const notification = subscriptionNotification();
    const parsed = parseRtdnNotification(
      Buffer.from(
        JSON.stringify(
          pushEnvelope({
            ...notification,
            subscriptionNotification: {
              ...notification.subscriptionNotification,
              subscriptionId: 'town_annual',
            },
          }),
        ),
        'utf8',
      ),
      { packageName: PACKAGE_NAME, subscription: SUBSCRIPTION },
    );
    expect(parsed.kind).toBe('subscription');
    expect(parsed).toHaveProperty('subscriptionId', 'town_annual');
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
  ])('rejects %s', (_name, envelope) => {
    expect(() =>
      parseRtdnNotification(Buffer.from(JSON.stringify(envelope), 'utf8'), {
        packageName: PACKAGE_NAME,
        subscription: SUBSCRIPTION,
      }),
    ).toThrow(RtdnParseError);
  });
});

describe('Google Play RTDN durable inbox boundary', () => {
  it('writes only the RTDN inbox table', async () => {
    const insertedTables: unknown[] = [];
    const db = {
      insert: vi.fn((table: unknown) => {
        insertedTables.push(table);
        return {
          values: () => ({
            onConflictDoNothing: () => ({
              returning: () => Promise.resolve([{ payloadHash: 'a'.repeat(64) }]),
            }),
          }),
        };
      }),
    } as unknown as Database['db'];

    await expect(
      persistGooglePlayRtdnInbox(db, {
        id: '00000000-0000-4000-8000-000000000001',
        pubsubSubscription: SUBSCRIPTION,
        messageId: 'message-123',
        notificationKind: 'subscription',
        notificationType: 2,
        purchaseToken: PURCHASE_TOKEN,
        eventTimeMillis: 1785042000000n,
        subscriptionId: 'town_annual',
        rawPayload: subscriptionNotification(),
        payloadHash: 'a'.repeat(64),
        receivedAt: '2026-07-26T06:47:00.000Z',
      }),
    ).resolves.toBe('inserted');

    expect(insertedTables).toEqual([googlePlayRtdnInbox]);
    expect(insertedTables).not.toContain(membershipEntitlements);
    expect(insertedTables).not.toContain(membershipSourceEvents);
    expect(insertedTables).not.toContain(googlePlayPurchaseLinks);
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

  it.each([
    ['subscription', subscriptionNotification()],
    ['one-time product', oneTimeNotification()],
    ['voided purchase', voidedNotification()],
  ])(
    'durably records a new real %s notification and returns 204 without Android Publisher access',
    async (_name, notification) => {
      const verifier = vi.fn<PubSubPushVerifier>().mockResolvedValue();
      const getSubscriptionV2 = vi.fn();
      const acknowledgeSubscription = vi.fn();
      const { rows, persistInbox } = createInMemoryInbox();
      const app = await createRtdnApp({
        verifier,
        androidPublisher: { getSubscriptionV2, acknowledgeSubscription },
        persistInbox,
      });
      apps.push(app);
      const response = await app.inject({
        method: 'POST',
        url: ROUTE,
        headers: { authorization: `Bearer ${JWT}` },
        payload: pushEnvelope(notification),
      });
      expect(response.statusCode).toBe(204);
      expect(rows.size).toBe(1);
      expect([...rows.values()][0]).toMatchObject({
        pubsubSubscription: SUBSCRIPTION,
        messageId: 'message-123',
        purchaseToken: PURCHASE_TOKEN,
        rawPayload: notification,
      });
      expect(getSubscriptionV2).not.toHaveBeenCalled();
      expect(acknowledgeSubscription).not.toHaveBeenCalled();
    },
  );

  it('acknowledges an identical redelivery while retaining one durable row', async () => {
    const verifier = vi.fn<PubSubPushVerifier>().mockResolvedValue();
    const { rows, persistInbox } = createInMemoryInbox();
    const app = await createRtdnApp({ verifier, persistInbox });
    apps.push(app);
    const request = {
      method: 'POST' as const,
      url: ROUTE,
      headers: { authorization: `Bearer ${JWT}` },
      payload: pushEnvelope(subscriptionNotification()),
    };

    const first = await app.inject(request);
    const redelivery = await app.inject(request);

    expect(first.statusCode).toBe(204);
    expect(redelivery.statusCode).toBe(204);
    expect(rows.size).toBe(1);
    expect(persistInbox).toHaveBeenCalledTimes(2);
  });

  it('returns 503 and retains one row when the same key has a different payload hash', async () => {
    const verifier = vi.fn<PubSubPushVerifier>().mockResolvedValue();
    const { rows, persistInbox } = createInMemoryInbox();
    const app = await createRtdnApp({ verifier, persistInbox });
    apps.push(app);

    const first = await app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Bearer ${JWT}` },
      payload: pushEnvelope(subscriptionNotification()),
    });
    const differentlyEncoded = pushEnvelope(subscriptionNotification());
    differentlyEncoded.message.data = Buffer.from(
      JSON.stringify(subscriptionNotification(), null, 2),
      'utf8',
    ).toString('base64');
    const conflict = await app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Bearer ${JWT}` },
      payload: differentlyEncoded,
    });

    expect(first.statusCode).toBe(204);
    expect(conflict.statusCode).toBe(503);
    expect(conflict.json()).toMatchObject({
      error: { code: 'GOOGLE_PLAY_RTDN_RETRY_REQUIRED' },
    });
    expect(rows.size).toBe(1);
  });

  it('returns 503 without a row when the durable insert fails', async () => {
    const verifier = vi.fn<PubSubPushVerifier>().mockResolvedValue();
    const rows: GooglePlayRtdnInboxRecord[] = [];
    const persistInbox = vi
      .fn<GooglePlayRtdnInboxPersister>()
      .mockRejectedValue(new Error('uncertain database result'));
    const app = await createRtdnApp({ verifier, persistInbox });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Bearer ${JWT}` },
      payload: pushEnvelope(subscriptionNotification()),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: 'GOOGLE_PLAY_RTDN_RETRY_REQUIRED' },
    });
    expect(rows).toHaveLength(0);
  });

  it('logs only bounded correlation metadata', async () => {
    const output = new PassThrough();
    let logs = '';
    output.on('data', (chunk: Buffer | string) => {
      logs += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    const verifier = vi.fn<PubSubPushVerifier>().mockResolvedValue();
    const { persistInbox } = createInMemoryInbox();
    const app = await createRtdnApp({
      verifier,
      logger: { level: 'info', stream: output },
      persistInbox,
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
    expect(response.statusCode).toBe(204);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(logs).not.toContain(JWT);
    expect(logs).not.toContain(PURCHASE_TOKEN);
    expect(logs).not.toContain(encodedPayload);
    expect(logs).not.toContain('purchase_token');
    expect(logs).not.toContain('raw_payload');
    expect(logs).toContain('message-123');
    expect(logs).toContain('google_play_rtdn_inbox_recorded');
  });
});
