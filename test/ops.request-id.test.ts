import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppInstance } from '../src/app.js';
import {
  generateRequestId,
  isAcceptableRequestId,
  resolveRequestId,
} from '../src/ops/request-id.js';
import { createTestApp } from './helpers/app.js';

describe('request-id helper', () => {
  it('accepts safe ids within bounds', () => {
    expect(isAcceptableRequestId('req_1234-5678')).toBe(true);
    expect(isAcceptableRequestId('a.b:c-d_e')).toBe(true);
    expect(isAcceptableRequestId('X'.repeat(128))).toBe(true);
  });

  it('rejects overlong, empty, or unsafe ids', () => {
    expect(isAcceptableRequestId('')).toBe(false);
    expect(isAcceptableRequestId('X'.repeat(129))).toBe(false);
    expect(isAcceptableRequestId('has space')).toBe(false);
    expect(isAcceptableRequestId('has\nnewline')).toBe(false);
    expect(isAcceptableRequestId('has/slash')).toBe(false);
    expect(isAcceptableRequestId('has;semi')).toBe(false);
    expect(isAcceptableRequestId(undefined)).toBe(false);
    expect(isAcceptableRequestId(42)).toBe(false);
  });

  it('generates req_<uuid> prefixed ids', () => {
    const id = generateRequestId(() => '11111111-1111-1111-1111-111111111111');
    expect(id).toBe('req_11111111-1111-1111-1111-111111111111');
  });

  it('resolveRequestId returns validated header verbatim', () => {
    expect(resolveRequestId('req_client-123', () => 'x')).toBe('req_client-123');
  });

  it('resolveRequestId falls back to generator when header invalid', () => {
    expect(resolveRequestId('bad id!!', () => 'aaa')).toBe('req_aaa');
    expect(resolveRequestId(undefined, () => 'bbb')).toBe('req_bbb');
  });
});

describe('request-id Fastify integration', () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a valid client-provided x-request-id and echoes it on the response', async () => {
    const provided = 'req_test-1234';
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': provided },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe(provided);
  });

  it('generates a new id when the client-provided value is malformed', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'has space and $ymbols' },
    });
    expect(response.statusCode).toBe(200);
    const echoed = response.headers['x-request-id'];
    expect(typeof echoed).toBe('string');
    expect(echoed).toMatch(/^req_/);
    expect(echoed).not.toBe('has space and $ymbols');
  });

  it('generates a new id when no header is provided', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toMatch(/^req_/);
  });
});
