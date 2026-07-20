import { describe, expect, it } from 'vitest';
import type { CreateResendDeliveryAdapterOptions } from '../src/ceremony/email-verification/resend-delivery.js';
import { createResendDeliveryAdapter } from '../src/ceremony/email-verification/resend-delivery.js';

const API_KEY = 're_test_resend_api_key_12345';
const FROM = 'verify@towncivic.org';
const CODE = '012345';
const EXPIRES = '2026-07-16T14:10:00.000Z';

type FetchFn = NonNullable<CreateResendDeliveryAdapterOptions['fetch']>;

function bodyText(init: RequestInit | undefined): string {
  if (typeof init?.body === 'string') {
    return init.body;
  }
  return '';
}

describe('createResendDeliveryAdapter', () => {
  it('POSTs to Resend with bearer auth and payload including reply_to', async () => {
    const calls: { input: Parameters<FetchFn>[0]; init?: Parameters<FetchFn>[1] }[] = [];
    const fetchMock: FetchFn = (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(new Response('{"id":"msg_1"}', { status: 200 }));
    };
    const adapter = createResendDeliveryAdapter({
      apiKey: API_KEY,
      from: FROM,
      replyTo: 'support@towncivic.org',
      fetch: fetchMock,
    });

    const result = await adapter.deliverVerificationCode({
      email: 'user@example.com',
      locale: 'en',
      code: CODE,
      expiresAt: EXPIRES,
      purpose: 'verify_email',
      outcomeCategory: 'verification_code',
      requestId: 'req_test_1',
    });

    expect(adapter.mode).toBe('resend');
    expect(result).toEqual({ delivered: true, outcomeCategory: 'verification_code' });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.input).toBe('https://api.resend.com/emails');
    expect(call?.init?.method).toBe('POST');
    expect(call?.init?.headers).toMatchObject({
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(bodyText(call?.init)) as Record<string, string>;
    expect(body.from).toBe(FROM);
    expect(body.to).toBe('user@example.com');
    expect(body.subject).toBe('Your TOWN verification code');
    expect(body.text).toContain(CODE);
    expect(body.text).toContain(EXPIRES);
    expect(body.reply_to).toBe('support@towncivic.org');
    expect(body.text).not.toContain(API_KEY);
  });

  it('does not call fetch for non-verification_code outcomes', async () => {
    let called = false;
    const fetchMock: FetchFn = () => {
      called = true;
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const adapter = createResendDeliveryAdapter({
      apiKey: API_KEY,
      from: FROM,
      fetch: fetchMock,
    });

    for (const outcomeCategory of [
      'existing_account_guidance',
      'suppressed',
      'unavailable',
    ] as const) {
      const result = await adapter.deliverVerificationCode({
        email: 'user@example.com',
        locale: 'en',
        code: CODE,
        expiresAt: EXPIRES,
        purpose: 'verify_email',
        outcomeCategory,
      });
      expect(result).toEqual({ delivered: false, outcomeCategory });
    }
    expect(called).toBe(false);
  });

  it('returns delivered false on non-2xx without leaking the code', async () => {
    const logs: unknown[] = [];
    const fetchMock: FetchFn = () =>
      Promise.resolve(
        new Response(JSON.stringify({ message: 'bad', code: CODE }), { status: 429 }),
      );
    const adapter = createResendDeliveryAdapter({
      apiKey: API_KEY,
      from: FROM,
      fetch: fetchMock,
      log: (event) => {
        logs.push(event);
      },
    });

    const result = await adapter.deliverVerificationCode({
      email: 'user@example.com',
      locale: 'it',
      code: CODE,
      expiresAt: EXPIRES,
      purpose: 'verify_email',
      outcomeCategory: 'verification_code',
      requestId: 'req_fail',
    });

    expect(result.delivered).toBe(false);
    expect(logs).toEqual([
      {
        event: 'email_delivery_failed',
        provider: 'resend',
        reason: 'http_error',
        status: 429,
        requestId: 'req_fail',
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain(CODE);
    expect(JSON.stringify(logs)).not.toContain(API_KEY);
    expect(JSON.stringify(logs)).not.toContain('user@example.com');
  });

  it('returns delivered false on timeout without leaking secrets', async () => {
    const logs: unknown[] = [];
    const fetchMock: FetchFn = () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      return Promise.reject(error);
    };
    const adapter = createResendDeliveryAdapter({
      apiKey: API_KEY,
      from: FROM,
      fetch: fetchMock,
      timeoutMs: 50,
      log: (event) => {
        logs.push(event);
      },
    });

    const result = await adapter.deliverVerificationCode({
      email: 'user@example.com',
      locale: 'de',
      code: CODE,
      expiresAt: EXPIRES,
      purpose: 'verify_email',
      outcomeCategory: 'verification_code',
      requestId: 'req_timeout',
    });

    expect(result.delivered).toBe(false);
    expect(logs).toEqual([
      {
        event: 'email_delivery_failed',
        provider: 'resend',
        reason: 'timeout',
        requestId: 'req_timeout',
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain(CODE);
    expect(JSON.stringify(logs)).not.toContain(API_KEY);
  });

  it('builds locale-specific plain text for it and de', async () => {
    const bodies: string[] = [];
    const fetchMock: FetchFn = (_input, init) => {
      bodies.push(bodyText(init));
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const adapter = createResendDeliveryAdapter({
      apiKey: API_KEY,
      from: FROM,
      fetch: fetchMock,
    });

    await adapter.deliverVerificationCode({
      email: 'user@example.com',
      locale: 'it',
      code: CODE,
      expiresAt: EXPIRES,
      purpose: 'verify_email',
      outcomeCategory: 'verification_code',
    });
    const itBody = JSON.parse(bodies[0] ?? '{}') as { subject: string; text: string };
    expect(itBody.subject).toContain('verifica');
    expect(itBody.text).toContain(CODE);

    await adapter.deliverVerificationCode({
      email: 'user@example.com',
      locale: 'de',
      code: CODE,
      expiresAt: EXPIRES,
      purpose: 'verify_email',
      outcomeCategory: 'verification_code',
    });
    const deBody = JSON.parse(bodies[1] ?? '{}') as { subject: string; text: string };
    expect(deBody.subject).toContain('Bestätigungscode');
    expect(deBody.text).toContain(CODE);
  });
});
