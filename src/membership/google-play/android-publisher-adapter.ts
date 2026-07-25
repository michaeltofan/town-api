import { JWT } from 'google-auth-library';
import {
  parseSubscriptionPurchaseV2,
  type GooglePlaySubscriptionPurchaseV2,
} from './subscription-purchase-v2.js';

export const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

export type GooglePlayServiceAccountCredentials = {
  clientEmail: string;
  privateKey: string;
};

/**
 * Bounded Google Play Android Publisher adapter. Only subscriptionsv2.get is exposed.
 */
export type TownGooglePlayAndroidPublisherAdapter = {
  getSubscriptionV2: (input: {
    packageName: string;
    purchaseToken: string;
  }) => Promise<GooglePlaySubscriptionPurchaseV2>;
};

export class GooglePlayAndroidPublisherError extends Error {
  readonly code: string;
  readonly httpStatus?: number;

  constructor(code: string, message: string, httpStatus?: number) {
    super(message);
    this.name = 'GooglePlayAndroidPublisherError';
    this.code = code;
    if (httpStatus !== undefined) {
      this.httpStatus = httpStatus;
    }
  }
}

export function parseGooglePlayServiceAccountJson(
  raw: string,
): { ok: true; credentials: GooglePlayServiceAccountCredentials } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: 'service_account_json_invalid' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'service_account_json_not_object' };
  }
  const record = parsed as Record<string, unknown>;
  const clientEmail = record.client_email;
  const privateKey = record.private_key;
  if (typeof clientEmail !== 'string' || clientEmail.length === 0 || !clientEmail.includes('@')) {
    return { ok: false, reason: 'service_account_client_email_invalid' };
  }
  if (
    typeof privateKey !== 'string' ||
    privateKey.length < 32 ||
    !privateKey.includes('PRIVATE KEY')
  ) {
    return { ok: false, reason: 'service_account_private_key_invalid' };
  }
  return {
    ok: true,
    credentials: {
      clientEmail,
      privateKey,
    },
  };
}

function buildSubscriptionV2Url(packageName: string, purchaseToken: string): string {
  const encodedPackage = encodeURIComponent(packageName);
  const encodedToken = encodeURIComponent(purchaseToken);
  return `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodedPackage}/purchases/subscriptionsv2/tokens/${encodedToken}`;
}

export type GooglePlayAccessTokenProvider = () => Promise<string>;

function createServiceAccountAccessTokenProvider(
  credentials: GooglePlayServiceAccountCredentials,
): GooglePlayAccessTokenProvider {
  const jwt = new JWT({
    email: credentials.clientEmail,
    key: credentials.privateKey,
    scopes: [ANDROID_PUBLISHER_SCOPE],
  });
  return async () => {
    const auth = await jwt.authorize();
    const accessToken = auth.access_token;
    if (!accessToken || accessToken.length === 0) {
      throw new GooglePlayAndroidPublisherError(
        'GOOGLE_AUTH_FAILED',
        'Google Play service account authorization returned no access token',
      );
    }
    return accessToken;
  };
}

/**
 * Production adapter. Authenticates with a Play Console service account and calls
 * purchases.subscriptionsv2.get. Never acknowledges purchases or mutates Play state.
 */
export function createOfficialGooglePlayAndroidPublisherAdapter(input: {
  serviceAccountJson: string;
  request?: (url: string, init?: RequestInit) => Promise<Response>;
  getAccessToken?: GooglePlayAccessTokenProvider;
}): TownGooglePlayAndroidPublisherAdapter {
  const parsed = parseGooglePlayServiceAccountJson(input.serviceAccountJson);
  if (!parsed.ok) {
    throw new GooglePlayAndroidPublisherError(
      'INVALID_SERVICE_ACCOUNT',
      'Google Play service account JSON is invalid',
    );
  }

  const getAccessToken =
    input.getAccessToken ?? createServiceAccountAccessTokenProvider(parsed.credentials);
  const requestFn = input.request ?? fetch;

  return {
    async getSubscriptionV2({ packageName, purchaseToken }) {
      if (!packageName || packageName.length === 0) {
        throw new GooglePlayAndroidPublisherError(
          'PACKAGE_NAME_REQUIRED',
          'packageName is required',
        );
      }
      if (!purchaseToken || purchaseToken.length === 0) {
        throw new GooglePlayAndroidPublisherError(
          'PURCHASE_TOKEN_REQUIRED',
          'purchaseToken is required',
        );
      }

      let accessToken: string;
      try {
        accessToken = await getAccessToken();
      } catch (error) {
        if (error instanceof GooglePlayAndroidPublisherError) {
          throw error;
        }
        throw new GooglePlayAndroidPublisherError(
          'GOOGLE_AUTH_FAILED',
          'Failed to authorize Google Play service account',
        );
      }
      if (accessToken.length === 0) {
        throw new GooglePlayAndroidPublisherError(
          'GOOGLE_AUTH_FAILED',
          'Google Play service account authorization returned no access token',
        );
      }

      const url = buildSubscriptionV2Url(packageName, purchaseToken);
      let response: Response;
      try {
        response = await requestFn(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
        });
      } catch {
        throw new GooglePlayAndroidPublisherError(
          'GOOGLE_PLAY_NETWORK_ERROR',
          'Google Play Android Publisher request failed',
        );
      }

      if (!response.ok) {
        throw new GooglePlayAndroidPublisherError(
          'GOOGLE_PLAY_HTTP_ERROR',
          'Google Play Android Publisher returned a non-success status',
          response.status,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new GooglePlayAndroidPublisherError(
          'GOOGLE_PLAY_RESPONSE_INVALID',
          'Google Play Android Publisher returned non-JSON',
        );
      }

      const parsedBody = parseSubscriptionPurchaseV2(body);
      if (!parsedBody.ok) {
        throw new GooglePlayAndroidPublisherError(
          'GOOGLE_PLAY_RESPONSE_INVALID',
          `Google Play SubscriptionPurchaseV2 payload invalid: ${parsedBody.reason}`,
        );
      }
      return parsedBody.purchase;
    },
  };
}

export type FakeGooglePlayAndroidPublisherState = {
  subscriptions: Map<string, GooglePlaySubscriptionPurchaseV2>;
  errorHooks: {
    getSubscriptionV2?: (input: { packageName: string; purchaseToken: string }) => Error | null;
  };
};

function subscriptionKey(packageName: string, purchaseToken: string): string {
  return `${packageName}\0${purchaseToken}`;
}

export function createFakeGooglePlayAndroidPublisherState(): FakeGooglePlayAndroidPublisherState {
  return {
    subscriptions: new Map(),
    errorHooks: {},
  };
}

export function createFakeGooglePlayAndroidPublisherAdapter(
  state: FakeGooglePlayAndroidPublisherState,
): TownGooglePlayAndroidPublisherAdapter {
  return {
    getSubscriptionV2(input) {
      const hooked = state.errorHooks.getSubscriptionV2?.(input) ?? null;
      if (hooked) {
        return Promise.reject(hooked);
      }
      const purchase = state.subscriptions.get(
        subscriptionKey(input.packageName, input.purchaseToken),
      );
      if (!purchase) {
        return Promise.reject(
          new GooglePlayAndroidPublisherError(
            'GOOGLE_PLAY_HTTP_ERROR',
            'Google Play Android Publisher returned a non-success status',
            404,
          ),
        );
      }
      return Promise.resolve(purchase);
    },
  };
}

export function setFakeGooglePlaySubscription(
  state: FakeGooglePlayAndroidPublisherState,
  input: {
    packageName: string;
    purchaseToken: string;
    purchase: GooglePlaySubscriptionPurchaseV2;
  },
): void {
  state.subscriptions.set(subscriptionKey(input.packageName, input.purchaseToken), input.purchase);
}
