import { describe, expect, it } from 'vitest';
import type { CreateRecoveryResendDeliveryAdapterOptions } from '../src/ceremony/account-recovery/resend-delivery.js';
import { createRecoveryResendDeliveryAdapter } from '../src/ceremony/account-recovery/resend-delivery.js';

const API_KEY = 're_test_recovery_resend_api_key_1';
const FROM = 'noreply@towncivic.org';
const CODE = '654321';
const EXPIRES = '2026-07-17T12:10:00.000Z';

type FetchFn = NonNullable<CreateRecoveryResendDeliveryAdapterOptions['fetch']>;

function bodyText(init: RequestInit | undefined): string {
  if (typeof init?.body === 'string') {
    return init.body;
  }
  return '';
}

describe('createRecoveryResendDeliveryAdapter', () => {
  it('POSTs to Resend with eligible recipient and recovery code', async () => {
    const calls: { input: Parameters<FetchFn>[0]; init?: Parameters<FetchFn>[1] }[] = [];
    const fetchMock: FetchFn = (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(new Response('{"id":"msg_1"}', { status: 200 }));
    };
    const adapter = createRecoveryResendDeliveryAdapter({
      apiKey: API_KEY,
      from: FROM,
      replyTo: 'support@towncivic.org',
      fetch: fetchMock,
    });

    const result = await adapter.deliverRecoveryCode({
      email: 'member@example.com',
      locale: 'en',
      code: CODE,
      expiresAt: EXPIRES,
      purpose: 'recover_account',
      outcomeCategory: 'recovery_code',
      requestId: 'req_recovery_1',
    });

    expect(adapter.mode).toBe('resend');
    expect(result).toEqual({ delivered: true, outcomeCategory: 'recovery_code' });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.input).toBe('https://api.resend.com/emails');
    expect(call?.init?.headers).toMatchObject({
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(bodyText(call?.init)) as {
      from?: string;
      to?: string;
      subject?: string;
      text?: string;
      reply_to?: string;
    };
    expect(body.from).toBe(FROM);
    expect(body.to).toBe('member@example.com');
    expect(body.subject?.toLowerCase()).toContain('recovery');
    expect(body.text).toContain(CODE);
    expect(body.text).toContain(EXPIRES);
    expect(body.text?.toLowerCase()).toContain('recover access');
    expect(body.text?.toLowerCase()).not.toContain('password reset');
    expect(body.text?.toLowerCase()).not.toContain('signed in');
    expect(body.reply_to).toBe('support@towncivic.org');
  });

  it('does not call Resend for suppressed outcomes', async () => {
    let called = false;
    const fetchMock: FetchFn = () => {
      called = true;
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const adapter = createRecoveryResendDeliveryAdapter({
      apiKey: API_KEY,
      from: FROM,
      fetch: fetchMock,
    });

    for (const outcomeCategory of ['suppressed', 'unavailable'] as const) {
      const result = await adapter.deliverRecoveryCode({
        email: 'member@example.com',
        locale: 'en',
        code: CODE,
        expiresAt: EXPIRES,
        purpose: 'recover_account',
        outcomeCategory,
      });
      expect(result).toEqual({ delivered: false, outcomeCategory });
    }
    expect(called).toBe(false);
  });

  it('logs delivery failures without the code, email, or API key', async () => {
    const logs: unknown[] = [];
    const fetchMock: FetchFn = () =>
      Promise.resolve(
        new Response(JSON.stringify({ message: 'bad', code: CODE }), { status: 502 }),
      );
    const adapter = createRecoveryResendDeliveryAdapter({
      apiKey: API_KEY,
      from: FROM,
      fetch: fetchMock,
      log: (event) => {
        logs.push(event);
      },
    });

    const result = await adapter.deliverRecoveryCode({
      email: 'member@example.com',
      locale: 'it',
      code: CODE,
      expiresAt: EXPIRES,
      purpose: 'recover_account',
      outcomeCategory: 'recovery_code',
      requestId: 'req_fail',
    });

    expect(result.delivered).toBe(false);
    expect(logs).toEqual([
      {
        event: 'recovery_email_delivery_failed',
        provider: 'resend',
        reason: 'http_error',
        status: 502,
        requestId: 'req_fail',
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain(CODE);
    expect(JSON.stringify(logs)).not.toContain(API_KEY);
    expect(JSON.stringify(logs)).not.toContain('member@example.com');
  });

  it('builds locale-specific recovery copy for it and de', async () => {
    const bodies: string[] = [];
    const fetchMock: FetchFn = (_input, init) => {
      bodies.push(bodyText(init));
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const adapter = createRecoveryResendDeliveryAdapter({
      apiKey: API_KEY,
      from: FROM,
      fetch: fetchMock,
    });

    await adapter.deliverRecoveryCode({
      email: 'member@example.com',
      locale: 'it',
      code: CODE,
      expiresAt: EXPIRES,
      purpose: 'recover_account',
      outcomeCategory: 'recovery_code',
    });
    const itBody = JSON.parse(bodies[0] ?? '{}') as { subject: string; text: string };
    expect(itBody.subject.toLowerCase()).toContain('recupero');
    expect(itBody.text).toContain(CODE);

    await adapter.deliverRecoveryCode({
      email: 'member@example.com',
      locale: 'de',
      code: CODE,
      expiresAt: EXPIRES,
      purpose: 'recover_account',
      outcomeCategory: 'recovery_code',
    });
    const deBody = JSON.parse(bodies[1] ?? '{}') as { subject: string; text: string };
    expect(deBody.subject.toLowerCase()).toContain('wiederherstellung');
    expect(deBody.text).toContain(CODE);
  });
});
