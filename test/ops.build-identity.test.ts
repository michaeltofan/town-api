import { describe, expect, it } from 'vitest';
import { buildIdentityFromEnv, getServiceVersion } from '../src/ops/build-identity.js';
import { EXPECTED_MIGRATION_COUNT } from '../src/db/migration-ledger.js';
import { createTestEnv } from './helpers/env.js';

describe('buildIdentityFromEnv', () => {
  it('reads the service version from package.json exactly once at module load', () => {
    const first = getServiceVersion();
    const second = getServiceVersion();
    expect(first).toBe(second);
    expect(first).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns the exact contract shape for the current runtime env', () => {
    const env = createTestEnv();
    const identity = buildIdentityFromEnv(env);
    expect(identity).toEqual({
      service: 'town-api',
      version: getServiceVersion(),
      commitSha: null,
      environment: 'test',
      nodeVersion: process.version,
      buildTimestamp: null,
      expectedMigrationCount: EXPECTED_MIGRATION_COUNT,
    });
  });

  it('surfaces APP_COMMIT_SHA and APP_BUILD_TIMESTAMP when set', () => {
    const env = createTestEnv({
      APP_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
      APP_BUILD_TIMESTAMP: '2026-07-17T00:00:00Z',
    });
    const identity = buildIdentityFromEnv(env);
    expect(identity.commitSha).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(identity.buildTimestamp).toBe('2026-07-17T00:00:00Z');
  });

  it('prefers RAILWAY_GIT_COMMIT_SHA over APP_COMMIT_SHA when both match', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const env = createTestEnv({
      RAILWAY_GIT_COMMIT_SHA: sha,
      APP_COMMIT_SHA: sha,
    });
    const identity = buildIdentityFromEnv(env);
    expect(identity.commitSha).toBe(sha);
  });

  it('expected migration count matches drizzle journal exactly', () => {
    const env = createTestEnv();
    const identity = buildIdentityFromEnv(env);
    expect(identity.expectedMigrationCount).toBe(EXPECTED_MIGRATION_COUNT);
    expect(EXPECTED_MIGRATION_COUNT).toBe(46);
  });

  it('never emits secret fields', () => {
    const env = createTestEnv();
    const identity = buildIdentityFromEnv(env);
    const serialized = JSON.stringify(identity);
    expect(serialized).not.toMatch(/postgres|DATABASE_URL|password|127\.0\.0\.1|sk_|whsec_/i);
  });
});
