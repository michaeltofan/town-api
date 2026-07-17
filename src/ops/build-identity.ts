import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../config/env.js';
import { EXPECTED_MIGRATION_COUNT } from '../db/migration-ledger.js';

/**
 * Immutable runtime build identity for /health/build and structured logger bindings.
 * Assembled from validated env + package.json read once at module load. Never
 * returns secrets, connection strings, or dynamic per-request data.
 */
export type BuildIdentity = {
  readonly service: 'town-api';
  readonly version: string;
  readonly commitSha: string | null;
  readonly environment: Env['APP_ENV'];
  readonly nodeVersion: string;
  readonly buildTimestamp: string | null;
  readonly expectedMigrationCount: number;
};

function readServiceVersion(): string {
  // dist/ops/build-identity.js → ../../package.json (dist/../package.json)
  // src/ops/build-identity.ts   → ../../package.json (src/../package.json)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.resolve(here, '..', '..', 'package.json');
  const raw = readFileSync(packageJsonPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { version?: unknown }).version !== 'string'
  ) {
    throw new Error('build-identity: package.json version is missing or invalid');
  }
  return (parsed as { version: string }).version;
}

const SERVICE_VERSION = readServiceVersion();

export function getServiceVersion(): string {
  return SERVICE_VERSION;
}

export function buildIdentityFromEnv(env: Env): BuildIdentity {
  return {
    service: 'town-api',
    version: SERVICE_VERSION,
    commitSha: env.APP_COMMIT_SHA ?? null,
    environment: env.APP_ENV,
    nodeVersion: process.version,
    buildTimestamp: env.APP_BUILD_TIMESTAMP ?? null,
    expectedMigrationCount: EXPECTED_MIGRATION_COUNT,
  };
}
