import { buildApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import type { Database } from '../db/client.js';

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }

  return value;
}

export function serializeOpenApiDocument(document: unknown): string {
  return `${JSON.stringify(sortValue(document), null, 2)}\n`;
}

function createOpenApiDatabaseStub(): Database {
  return {
    pool: undefined as unknown as Database['pool'],
    db: undefined as unknown as Database['db'],
    checkReadiness: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
}

export async function generateOpenApiDocument(): Promise<unknown> {
  const env = loadEnv({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    LOG_LEVEL: 'silent',
    // Placeholder only — OpenAPI generation injects a stub database and never connects.
    DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town_openapi',
  });

  const app = await buildApp({
    env,
    logger: false,
    database: createOpenApiDatabaseStub(),
  });

  try {
    await app.ready();
    return app.swagger();
  } finally {
    await app.close();
  }
}
