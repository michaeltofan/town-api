import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/client.js';
import { CONTROLLED_TEST_ACTOR_ID } from '../src/db/seeds/controlled-actor-content.js';
import { FOUNDATION_SIGNAL_IDS } from '../src/db/seeds/foundation-content.js';
import {
  CONTROLLED_TEST_KEY,
  createControlledConfirmationTestApp,
  requireDatabaseUrl,
  resetMigrateSeedFoundationAndActor,
} from './helpers/pg.js';
import { Pool } from 'pg';

describe('controlled confirmation access', () => {
  let enabledApp: Awaited<ReturnType<typeof createControlledConfirmationTestApp>>;

  beforeAll(async () => {
    enabledApp = await createControlledConfirmationTestApp({ enabled: true });
  });

  afterAll(async () => {
    await enabledApp.app.close();
    await enabledApp.pool.end();
  });

  it('does not include the control key in responses or request logs', async () => {
    const databaseUrl = requireDatabaseUrl();
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetMigrateSeedFoundationAndActor(pool);

    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        callback();
      },
    });

    const env = loadEnv({
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '3000',
      LOG_LEVEL: 'info',
      DATABASE_URL: databaseUrl,
      DB_POOL_MAX: '5',
      DB_CONNECTION_TIMEOUT_MS: '3000',
      DB_IDLE_TIMEOUT_MS: '1000',
      CONTROLLED_CONFIRMATION_ENABLED: 'true',
      CONTROLLED_CONFIRMATION_KEY: CONTROLLED_TEST_KEY,
      CONTROLLED_TEST_ACTOR_ID,
    });

    const database = createDatabase({
      connectionString: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
    });

    const app = await buildApp({
      env,
      database,
      logger: {
        level: 'info',
        stream,
      },
    });
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
        headers: {
          'x-town-control-key': CONTROLLED_TEST_KEY,
          'x-town-actor-id': '00000000-0000-4000-8000-000000000399',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.stringify(response.json())).not.toContain(CONTROLLED_TEST_KEY);
      expect(JSON.stringify(response.json())).not.toContain('actorId');
      expect(JSON.stringify(response.json())).not.toContain(CONTROLLED_TEST_ACTOR_ID);

      // Force a request log line if the logger emits on inject.
      app.log.info({ req: { headers: { 'x-town-control-key': CONTROLLED_TEST_KEY } } }, 'probe');

      const joined = chunks.join('\n');
      expect(joined).not.toContain(CONTROLLED_TEST_KEY);
      if (joined.includes('x-town-control-key')) {
        expect(joined).toContain('[Redacted]');
      }
    } finally {
      await app.close();
      await database.close();
      await pool.end();
    }
  });

  it('rejects malformed configured actor id at startup validation', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: '3000',
        LOG_LEVEL: 'silent',
        DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
        CONTROLLED_CONFIRMATION_ENABLED: 'true',
        CONTROLLED_CONFIRMATION_KEY: CONTROLLED_TEST_KEY,
        CONTROLLED_TEST_ACTOR_ID: 'bad-actor',
      }),
    ).toThrow(/CONTROLLED_TEST_ACTOR_ID must be a valid UUID/);
  });

  it('valid key continues for enabled feature', async () => {
    const response = await enabledApp.app.inject({
      method: 'GET',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
      headers: { 'x-town-control-key': enabledApp.controlKey },
    });
    expect(response.statusCode).toBe(200);
  });

  it('feature disabled returns safe 404 and missing/invalid keys return 401', async () => {
    const disabled = await createControlledConfirmationTestApp({ enabled: false });
    try {
      const response = await disabled.app.inject({
        method: 'GET',
        url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
        headers: { 'x-town-control-key': CONTROLLED_TEST_KEY },
      });
      expect(response.statusCode).toBe(404);
      expect(JSON.stringify(response.json())).not.toContain(CONTROLLED_TEST_KEY);
    } finally {
      await disabled.app.close();
      await disabled.pool.end();
    }

    const missing = await enabledApp.app.inject({
      method: 'GET',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
    });
    expect(missing.statusCode).toBe(401);

    const invalid = await enabledApp.app.inject({
      method: 'GET',
      url: `/v1/signals/${FOUNDATION_SIGNAL_IDS.milanoSignal1}/confirmation`,
      headers: { 'x-town-control-key': 'invalid-key-value' },
    });
    expect(invalid.statusCode).toBe(401);
    expect(JSON.stringify(invalid.json())).not.toContain(CONTROLLED_TEST_KEY);
    expect(JSON.stringify(invalid.json())).not.toContain('invalid-key-value');
  });
});
