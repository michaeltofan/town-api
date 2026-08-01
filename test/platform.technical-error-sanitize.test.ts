import { describe, expect, it } from 'vitest';
import {
  sanitizeTechnicalErrorMessage,
  sanitizeTechnicalErrorName,
  sanitizeTechnicalErrorRoute,
  shouldRecordTechnicalError,
} from '../src/platform/services/technical-error-sanitize.js';

describe('technical error sanitize', () => {
  it('redacts emails and secret-looking messages', () => {
    expect(sanitizeTechnicalErrorMessage('boom for user@example.com')).toBe(
      'boom for [redacted-email]',
    );
    expect(sanitizeTechnicalErrorMessage('invalid password hash')).toBe(
      'An unexpected error occurred.',
    );
  });

  it('strips stacks to the first line and bounds length', () => {
    const long = `${'x'.repeat(300)}\n    at Object.<anonymous> (/tmp/a.js:1:1)`;
    const sanitized = sanitizeTechnicalErrorMessage(long);
    expect(sanitized.includes('\n')).toBe(false);
    expect(sanitized.length).toBeLessThanOrEqual(240);
  });

  it('prefers router templates and strips query strings', () => {
    expect(
      sanitizeTechnicalErrorRoute({
        method: 'post',
        routerPath: '/v1/billing/checkout',
        url: '/v1/billing/checkout?token=abc',
      }),
    ).toEqual({ method: 'POST', route: '/v1/billing/checkout' });

    expect(
      sanitizeTechnicalErrorRoute({
        method: 'GET',
        url: '/v1/platform/status?x=1',
      }),
    ).toEqual({ method: 'GET', route: '/v1/platform/status' });
  });

  it('records only server errors outside health probes', () => {
    expect(
      shouldRecordTechnicalError({
        statusCode: 500,
        routerPath: '/v1/platform/status',
      }),
    ).toBe(true);
    expect(
      shouldRecordTechnicalError({
        statusCode: 404,
        routerPath: '/v1/platform/status',
      }),
    ).toBe(false);
    expect(
      shouldRecordTechnicalError({
        statusCode: 500,
        routerPath: '/health/ready',
      }),
    ).toBe(false);
  });

  it('sanitizes error names', () => {
    expect(sanitizeTechnicalErrorName('TypeError')).toBe('TypeError');
    expect(sanitizeTechnicalErrorName('password leak')).toBeNull();
  });
});
