import { describe, expect, it, vi } from 'vitest';
import {
  createOfficialGooglePlayAndroidPublisherAdapter,
  parseGooglePlayServiceAccountJson,
} from '../src/membership/google-play/android-publisher-adapter.js';

const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'play-api@example.iam.gserviceaccount.com',
  private_key:
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC0REPLACE\n-----END PRIVATE KEY-----\n',
});

describe('Google Play Android Publisher adapter', () => {
  it('parses valid service account JSON', () => {
    const parsed = parseGooglePlayServiceAccountJson(SERVICE_ACCOUNT_JSON);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.credentials.clientEmail).toBe('play-api@example.iam.gserviceaccount.com');
      expect(parsed.credentials.privateKey).toContain('PRIVATE KEY');
    }
  });

  it('rejects invalid service account JSON fail-closed', () => {
    expect(parseGooglePlayServiceAccountJson('{bad')).toEqual({
      ok: false,
      reason: 'service_account_json_invalid',
    });
  });

  it('calls subscriptionsv2.get with bearer auth and parses the response', async () => {
    const getAccessToken = vi.fn(() => Promise.resolve('ya29.test-token'));
    const request = vi.fn((url: string, init?: RequestInit) => {
      expect(url).toContain(
        '/applications/com.town.town_safe_space_mobile/purchases/subscriptionsv2/tokens/',
      );
      expect(url).toContain(encodeURIComponent('token/with spaces'));
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer ya29.test-token',
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
            lineItems: [
              {
                productId: 'town_annual_membership',
                expiryTime: '2027-07-25T12:00:00.000Z',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });

    const adapter = createOfficialGooglePlayAndroidPublisherAdapter({
      serviceAccountJson: SERVICE_ACCOUNT_JSON,
      getAccessToken,
      request,
    });
    const purchase = await adapter.getSubscriptionV2({
      packageName: 'com.town.town_safe_space_mobile',
      purchaseToken: 'token/with spaces',
    });
    expect(purchase.subscriptionState).toBe('SUBSCRIPTION_STATE_ACTIVE');
    expect(purchase.lineItems[0]?.productId).toBe('town_annual_membership');
    expect(request).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('throws a bounded error on non-success Google HTTP status', async () => {
    const adapter = createOfficialGooglePlayAndroidPublisherAdapter({
      serviceAccountJson: SERVICE_ACCOUNT_JSON,
      getAccessToken: () => Promise.resolve('ya29.test-token'),
      request: () => Promise.resolve(new Response('not found', { status: 404 })),
    });
    await expect(
      adapter.getSubscriptionV2({
        packageName: 'com.town.town_safe_space_mobile',
        purchaseToken: 'missing',
      }),
    ).rejects.toMatchObject({
      name: 'GooglePlayAndroidPublisherError',
      code: 'GOOGLE_PLAY_HTTP_ERROR',
      httpStatus: 404,
    });
  });
});
