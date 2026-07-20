import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppInstance } from '../src/app.js';
import { ERROR_CODE } from '../src/schemas/error.js';
import { createTestApp } from './helpers/app.js';

describe('error responses', () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('unknown routes return a safe domain error format', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/does-not-exist',
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);

    const body = response.json<{
      error: { code: string; message: string; requestId: string };
    }>();

    expect(body).toEqual({
      error: {
        code: ERROR_CODE.NOT_FOUND,
        message: 'Not Found.',
        requestId: expect.any(String) as string,
      },
    });
    expect(Object.keys(body).sort()).toEqual(['error']);
    expect(JSON.stringify(body)).not.toMatch(/stack|node_modules|Error:/i);
  });

  it('includes requestId in error responses', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/missing',
      headers: {
        'x-request-id': 'test-request-id-123',
      },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { requestId: string } }>();
    expect(body.error.requestId).toBe('test-request-id-123');
  });
});
