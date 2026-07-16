import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDatabase } from '../src/db/client.js';
import { signalConfirmations } from '../src/db/schema.js';
import { FOUNDATION_SIGNAL_IDS } from '../src/db/seeds/foundation-content.js';
import {
  CONTROLLED_TEST_KEY,
  createControlledConfirmationTestApp,
  requireDatabaseUrl,
} from './helpers/pg.js';

describe('signal confirmation API', () => {
  const databaseUrl = requireDatabaseUrl();
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

  it('returns unconfirmed then confirmed state with exact fields', async () => {
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;

    const before = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/confirmation`,
      headers: { 'x-town-control-key': controlKey },
    });
    expect(before.statusCode).toBe(200);
    expect(before.headers['content-type']).toContain('application/json');
    expect(before.json()).toEqual({
      data: {
        signalId,
        confirmed: false,
        confirmedAt: null,
      },
    });

    const put = await app.inject({
      method: 'PUT',
      url: `/v1/signals/${signalId}/confirmation`,
      headers: {
        'x-town-control-key': controlKey,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(put.statusCode).toBe(200);
    const putBody: {
      data: { signalId: string; confirmed: boolean; confirmedAt: string };
    } = put.json();
    expect(putBody).toEqual({
      data: {
        signalId,
        confirmed: true,
        confirmedAt: putBody.data.confirmedAt,
      },
    });
    expect(putBody.data.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(putBody)).not.toMatch(/actor|count|confirmationId|CONTROLLED/i);

    const after = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/confirmation`,
      headers: { 'x-town-control-key': controlKey },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({
      data: {
        signalId,
        confirmed: true,
        confirmedAt: putBody.data.confirmedAt,
      },
    });
  });

  it('PUT is idempotent and keeps confirmedAt stable', async () => {
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal2;

    const first = await app.inject({
      method: 'PUT',
      url: `/v1/signals/${signalId}/confirmation`,
      headers: { 'x-town-control-key': controlKey, 'content-type': 'application/json' },
      payload: {},
    });
    const second = await app.inject({
      method: 'PUT',
      url: `/v1/signals/${signalId}/confirmation`,
      headers: { 'x-town-control-key': controlKey, 'content-type': 'application/json' },
      payload: {},
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstBody: { data: { confirmedAt: string } } = first.json();
    const secondBody: { data: { confirmedAt: string } } = second.json();
    expect(secondBody.data.confirmedAt).toBe(firstBody.data.confirmedAt);

    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 1,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    try {
      const total = await database.db
        .select({ value: count() })
        .from(signalConfirmations)
        .where(eq(signalConfirmations.signalId, signalId));
      expect(total[0]?.value).toBe(1);
    } finally {
      await database.close();
    }
  });

  it('concurrent PUT requests create exactly one confirmation row', async () => {
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal3;

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: 'PUT',
          url: `/v1/signals/${signalId}/confirmation`,
          headers: { 'x-town-control-key': controlKey, 'content-type': 'application/json' },
          payload: {},
        }),
      ),
    );

    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    const confirmedAts = new Set(
      responses.map((response) => {
        const body: { data: { confirmedAt: string } } = response.json();
        return body.data.confirmedAt;
      }),
    );
    expect(confirmedAts.size).toBe(1);

    const database = createDatabase({
      connectionString: databaseUrl,
      poolMax: 1,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    try {
      const total = await database.db
        .select({ value: count() })
        .from(signalConfirmations)
        .where(eq(signalConfirmations.signalId, signalId));
      expect(total[0]?.value).toBe(1);
    } finally {
      await database.close();
    }
  });

  it('enforces access, eligibility, validation, and empty body rules', async () => {
    const disabled = await createControlledConfirmationTestApp({ enabled: false });
    try {
      const response = await disabled.app.inject({
        method: 'PUT',
        url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
        headers: { 'x-town-control-key': CONTROLLED_TEST_KEY },
        payload: {},
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        statusCode: 404,
        error: 'Not Found',
        message: 'Not Found',
      });
      expect(JSON.stringify(response.json())).not.toContain(CONTROLLED_TEST_KEY);
    } finally {
      await disabled.app.close();
      await disabled.pool.end();
    }

    const missingKey = await app.inject({
      method: 'GET',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
    });
    expect(missingKey.statusCode).toBe(401);
    expect(missingKey.json()).toMatchObject({
      error: {
        code: 'CONTROLLED_ACCESS_REQUIRED',
        message: 'Controlled access is required.',
      },
    });

    const invalidKey = await app.inject({
      method: 'GET',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
      headers: { 'x-town-control-key': 'wrong-key' },
    });
    expect(invalidKey.statusCode).toBe(401);
    expect(JSON.stringify(invalidKey.json())).not.toContain(controlKey);
    expect(JSON.stringify(invalidKey.json())).not.toContain('wrong-key');

    const munich = await app.inject({
      method: 'PUT',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.munichSignal1}/confirmation`,
      headers: { 'x-town-control-key': controlKey, 'content-type': 'application/json' },
      payload: {},
    });
    expect(munich.statusCode).toBe(403);
    expect(munich.json()).toMatchObject({
      error: {
        code: 'ACTOR_NOT_ELIGIBLE_FOR_COMMUNITY',
        message: 'The actor is not eligible for this community.',
      },
    });

    const munichGet = await app.inject({
      method: 'GET',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.munichSignal1}/confirmation`,
      headers: { 'x-town-control-key': controlKey },
    });
    expect(munichGet.statusCode).toBe(403);

    const missing = await app.inject({
      method: 'PUT',
      url: '/v1/signals/00000000-0000-4000-8000-000000000999/confirmation',
      headers: { 'x-town-control-key': controlKey, 'content-type': 'application/json' },
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: {
        code: 'SIGNAL_NOT_FOUND',
        message: 'The requested signal was not found.',
      },
    });

    const invalidUuid = await app.inject({
      method: 'PUT',
      url: '/v1/signals/not-a-uuid/confirmation',
      headers: { 'x-town-control-key': controlKey, 'content-type': 'application/json' },
      payload: {},
    });
    expect(invalidUuid.statusCode).toBe(400);

    const unexpectedBody = await app.inject({
      method: 'PUT',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
      headers: { 'x-town-control-key': controlKey, 'content-type': 'application/json' },
      payload: { actorId: 'client-chosen' },
    });
    expect(unexpectedBody.statusCode).toBe(400);
    expect(JSON.stringify(unexpectedBody.json())).not.toMatch(
      /00000000-0000-4000-8000-000000000301/,
    );
  });
});
