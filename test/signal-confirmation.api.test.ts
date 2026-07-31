import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { FOUNDATION_SIGNAL_IDS } from '../src/db/seeds/foundation-content.js';
import { CONTROLLED_TEST_KEY, createControlledConfirmationTestApp } from './helpers/pg.js';

/**
 * PUT /v1/signals/:signalId/confirmation is now a session-authenticated participant
 * confirmation route (covered by test/membership.confirmation.api.test.ts). The
 * controlled X-TOWN-Control-Key mechanism is preserved for GET only to maintain
 * historical read-only testing isolation for the controlled test actor.
 */
describe('signal confirmation controlled GET (historical isolation)', () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof createControlledConfirmationTestApp>>['app'];
  let controlKey: string;

  beforeAll(async () => {
    ({ app, pool, controlKey } = await createControlledConfirmationTestApp());
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('GET returns unconfirmed state for the controlled test actor', async () => {
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;
    const response = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/confirmation`,
      headers: { 'x-town-control-key': controlKey },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({
      data: {
        signalId,
        confirmed: false,
        confirmedAt: null,
        confirmationCount: 0,
      },
    });
    expect(JSON.stringify(response.json())).not.toContain(controlKey);
    expect(JSON.stringify(response.json())).not.toMatch(/actor|CONTROLLED/i);
  });

  it('GET rejects missing control key with 401 CONTROLLED_ACCESS_REQUIRED', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'CONTROLLED_ACCESS_REQUIRED' },
    });
  });

  it('GET rejects invalid control key without echoing the supplied value', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
      headers: { 'x-town-control-key': 'wrong-key' },
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.stringify(response.json())).not.toContain('wrong-key');
    expect(JSON.stringify(response.json())).not.toContain(controlKey);
  });

  it('GET rejects a Munich signal (community mismatch) with 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.munichSignal1}/confirmation`,
      headers: { 'x-town-control-key': controlKey },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'ACTOR_NOT_ELIGIBLE_FOR_COMMUNITY' },
    });
  });

  it('feature disabled returns safe 404 with no leak', async () => {
    const disabled = await createControlledConfirmationTestApp({ enabled: false });
    try {
      const response = await disabled.app.inject({
        method: 'GET',
        url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
        headers: { 'x-town-control-key': CONTROLLED_TEST_KEY },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: {
          code: 'NOT_FOUND',
          message: 'Not Found.',
        },
      });
      expect(JSON.stringify(response.json())).not.toContain(CONTROLLED_TEST_KEY);
    } finally {
      await disabled.app.close();
      await disabled.pool.end();
    }
  });

  it('PUT no longer accepts the control key as a bypass — a control-key-only PUT is rejected as session unauthorized', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
      headers: {
        'x-town-control-key': controlKey,
        'content-type': 'application/json',
      },
      payload: {},
    });
    // Without PASSKEY_AUTHENTICATION_ENABLED the route call-not-found path is used; when disabled
    // PUT returns 404. This controlled app runs with PASSKEY_AUTHENTICATION_ENABLED=false, so the
    // PUT route responds with 404 rather than 401 in this configuration. Either way, a control key
    // alone must never succeed.
    expect([401, 404]).toContain(response.statusCode);
    const body = JSON.stringify(response.json());
    expect(body).not.toMatch(/"confirmed":\s*true/);
    expect(body).not.toContain(controlKey);
  });

  it('missing signal returns 404 SIGNAL_NOT_FOUND', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/signals/00000000-0000-4000-8000-000000000999/confirmation',
      headers: { 'x-town-control-key': controlKey },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: 'SIGNAL_NOT_FOUND' },
    });
  });

  it('invalid UUID param returns 400', async () => {
    const invalidUuid = await app.inject({
      method: 'GET',
      url: '/v1/signals/not-a-uuid/confirmation',
      headers: { 'x-town-control-key': controlKey },
    });
    expect(invalidUuid.statusCode).toBe(400);
  });
});
