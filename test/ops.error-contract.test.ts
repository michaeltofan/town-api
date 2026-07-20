import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppInstance } from '../src/app.js';
import { ERROR_CODE } from '../src/schemas/error.js';
import { createTestApp } from './helpers/app.js';

const AUTH_ENV = {
  EMAIL_VERIFICATION_ENABLED: 'true',
  EMAIL_VERIFICATION_HASH_KEY: 'town-ci-email-verification-hash-key-32b',
  EMAIL_VERIFICATION_DELIVERY_MODE: 'test',
  CEREMONY_RATE_LIMIT_HASH_KEY: 'town-ci-ceremony-rate-limit-hash-key-32b',
  WEBAUTHN_REGISTRATION_ENABLED: 'true',
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_RP_NAME: 'TOWN',
  WEBAUTHN_ALLOWED_ORIGINS: 'http://localhost:3000',
  WEBAUTHN_CHALLENGE_HASH_KEY: 'town-ci-webauthn-challenge-hash-key-32by',
  PASSKEY_AUTHENTICATION_ENABLED: 'true',
  PASSKEY_AUTHENTICATION_CHALLENGE_HASH_KEY: 'town-ci-passkey-auth-challenge-hash-key32',
  SESSION_TOKEN_HASH_KEY: 'town-ci-session-token-hash-key-32bytesxx',
  ACCOUNT_RECOVERY_ENABLED: 'true',
  ACCOUNT_RECOVERY_HASH_KEY: 'town-ci-account-recovery-hash-key-32byt',
  ACCOUNT_RECOVERY_TOKEN_HASH_KEY: 'town-ci-account-recovery-token-key-32b',
  ACCOUNT_RECOVERY_DELIVERY_MODE: 'test',
} as const;

type DomainErrorBody = {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
};

function assertDomainError(
  response: { statusCode: number; body: string; json: () => unknown },
  expectedStatus: number,
  expectedCode: string,
): DomainErrorBody {
  expect(response.statusCode).toBe(expectedStatus);
  expect(response.statusCode).not.toBe(500);
  expect(response.body).not.toContain('FST_ERR_FAILED_ERROR_SERIALIZATION');
  expect(response.body).not.toMatch(/stack|node_modules/i);

  const body = response.json() as DomainErrorBody;
  expect(Object.keys(body).sort()).toEqual(['error']);
  expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId']);
  expect(body.error.code).toBe(expectedCode);
  expect(typeof body.error.message).toBe('string');
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(typeof body.error.requestId).toBe('string');
  expect(body.error.requestId.length).toBeGreaterThan(0);
  return body;
}

describe('unified domain error contract', () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = await createTestApp({ envOverrides: { ...AUTH_ENV } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('unknown routes return the domain NOT_FOUND envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/does-not-exist',
      headers: { 'x-request-id': 'test-request-id-404' },
    });
    const body = assertDomainError(response, 404, ERROR_CODE.NOT_FOUND);
    expect(body.error.requestId).toBe('test-request-id-404');
    expect(body.error.message).toBe('Not Found.');
  });

  describe('POST /v1/authentication/passkeys/options', () => {
    const url = '/v1/authentication/passkeys/options';

    it('rejects missing fields with VALIDATION_ERROR', async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: {},
      });
      assertDomainError(response, 400, ERROR_CODE.VALIDATION_ERROR);
    });

    it('rejects wrong field types with VALIDATION_ERROR', async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: { clientType: 123, anonymousClientKey: 99 },
      });
      assertDomainError(response, 400, ERROR_CODE.VALIDATION_ERROR);
    });

    it('rejects invalid JSON with MALFORMED_REQUEST', async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      });
      assertDomainError(response, 400, ERROR_CODE.MALFORMED_REQUEST);
    });

    it('rejects wrong content-type with MALFORMED_REQUEST', async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/xml' },
        body: '<x/>',
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      assertDomainError(response, response.statusCode, ERROR_CODE.MALFORMED_REQUEST);
    });

    it('rejects oversized payload with PAYLOAD_TOO_LARGE', async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ clientType: 'web', pad: 'x'.repeat(1_200_000) }),
      });
      assertDomainError(response, 413, ERROR_CODE.PAYLOAD_TOO_LARGE);
    });
  });

  describe('POST /v1/account/email-verifications/complete', () => {
    const url = '/v1/account/email-verifications/complete';

    it('rejects missing fields with VALIDATION_ERROR', async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: {},
      });
      assertDomainError(response, 400, ERROR_CODE.VALIDATION_ERROR);
    });

    it('rejects wrong field types with VALIDATION_ERROR', async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: { email: 1, code: true },
      });
      assertDomainError(response, 400, ERROR_CODE.VALIDATION_ERROR);
    });

    it('rejects invalid JSON with MALFORMED_REQUEST', async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      });
      assertDomainError(response, 400, ERROR_CODE.MALFORMED_REQUEST);
    });

    it('rejects wrong content-type with MALFORMED_REQUEST', async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/xml' },
        body: '<x/>',
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      assertDomainError(response, response.statusCode, ERROR_CODE.MALFORMED_REQUEST);
    });

    it('rejects oversized payload with PAYLOAD_TOO_LARGE', async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'a@b.co', code: '123456', pad: 'x'.repeat(1_200_000) }),
      });
      assertDomainError(response, 413, ERROR_CODE.PAYLOAD_TOO_LARGE);
    });
  });

  describe('POST /v1/account/recovery/verify-email', () => {
    const url = '/v1/account/recovery/verify-email';

    it('rejects missing fields with VALIDATION_ERROR', async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: {},
      });
      assertDomainError(response, 400, ERROR_CODE.VALIDATION_ERROR);
    });

    it('rejects wrong field types with VALIDATION_ERROR', async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: { email: false, code: [] },
      });
      assertDomainError(response, 400, ERROR_CODE.VALIDATION_ERROR);
    });

    it('rejects invalid JSON with MALFORMED_REQUEST', async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      });
      assertDomainError(response, 400, ERROR_CODE.MALFORMED_REQUEST);
    });

    it('rejects wrong content-type with MALFORMED_REQUEST', async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/xml' },
        body: '<x/>',
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      assertDomainError(response, response.statusCode, ERROR_CODE.MALFORMED_REQUEST);
    });

    it('rejects oversized payload with PAYLOAD_TOO_LARGE', async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'a@b.co', code: '123456', pad: 'x'.repeat(1_200_000) }),
      });
      assertDomainError(response, 413, ERROR_CODE.PAYLOAD_TOO_LARGE);
    });
  });
});
