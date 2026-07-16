import { buildApp } from '../app.js';
import { loadEnv } from '../config/env.js';

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

export async function generateOpenApiDocument(): Promise<unknown> {
  const env = loadEnv({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    LOG_LEVEL: 'silent',
  });

  const app = await buildApp({
    env,
    logger: false,
  });

  try {
    await app.ready();
    return app.swagger();
  } finally {
    await app.close();
  }
}
