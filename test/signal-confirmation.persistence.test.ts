import { describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { signalConfirmations } from '../src/db/schema.js';
import { CONTROLLED_TEST_ACTOR_ID } from '../src/db/seeds/controlled-actor-content.js';
import { FOUNDATION_SIGNAL_IDS } from '../src/db/seeds/foundation-content.js';
import {
  CONTROLLED_TEST_KEY,
  requireDatabaseUrl,
  resetMigrateSeedFoundationAndActor,
} from './helpers/pg.js';
import { Pool } from 'pg';

describe('confirmation persistence after restart', () => {
  it('keeps confirmed state and confirmedAt across app instance recreation', async () => {
    const databaseUrl = requireDatabaseUrl();
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetMigrateSeedFoundationAndActor(pool);

    const env = loadEnv({
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      DATABASE_URL: databaseUrl,
      DB_POOL_MAX: '5',
      DB_CONNECTION_TIMEOUT_MS: '3000',
      DB_IDLE_TIMEOUT_MS: '1000',
      CONTROLLED_CONFIRMATION_ENABLED: 'true',
      CONTROLLED_CONFIRMATION_KEY: CONTROLLED_TEST_KEY,
      CONTROLLED_TEST_ACTOR_ID,
    });

    const databaseA = createDatabase({
      connectionString: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
    });
    const appA = await buildApp({ env, logger: false, database: databaseA });
    await appA.ready();

    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;
    const put = await appA.inject({
      method: 'PUT',
      url: `/v1/signals/${signalId}/confirmation`,
      headers: {
        'x-town-control-key': CONTROLLED_TEST_KEY,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(put.statusCode).toBe(200);
    const putBody: { data: { confirmedAt: string } } = put.json();
    const confirmedAt = putBody.data.confirmedAt;

    await appA.close();
    await databaseA.close();

    const databaseB = createDatabase({
      connectionString: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
    });
    const appB = await buildApp({ env, logger: false, database: databaseB });
    await appB.ready();

    const get = await appB.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/confirmation`,
      headers: { 'x-town-control-key': CONTROLLED_TEST_KEY },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({
      data: {
        signalId,
        confirmed: true,
        confirmedAt,
      },
    });

    const total = await databaseB.db
      .select({ value: count() })
      .from(signalConfirmations)
      .where(eq(signalConfirmations.signalId, signalId));
    expect(total[0]?.value).toBe(1);

    await appB.close();
    await databaseB.close();
    await pool.end();
  });
});
