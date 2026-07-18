import { describe, expect, it } from 'vitest';
import {
  loadEnv,
  parseOptionalGitCommitSha,
  resolveEffectiveCommitSha,
} from '../src/config/env.js';
import { buildIdentityFromEnv } from '../src/ops/build-identity.js';
import { createTestEnv } from './helpers/env.js';

const PROD_DATABASE_URL = 'postgres://town-prod:prod-secret@db.internal:5432/town';
const STG_DATABASE_URL = 'postgres://town-stg:stg-secret@db.internal:5432/town';
const COMMIT_A = '1234567890abcdef1234567890abcdef12345678';
const COMMIT_B = 'abcdef0123456789abcdef0123456789abcdef01';
const INVALID_ABBREV = '1234567890abcdef';
const INVALID_UPPER = '1234567890ABCDEF1234567890ABCDEF12345678';

describe('deployment commit identity resolution', () => {
  describe('parseOptionalGitCommitSha', () => {
    it('accepts a full lowercase 40-character SHA', () => {
      expect(parseOptionalGitCommitSha(COMMIT_A, 'APP_COMMIT_SHA')).toBe(COMMIT_A);
    });

    it('treats absent and empty as undefined', () => {
      expect(parseOptionalGitCommitSha(undefined, 'APP_COMMIT_SHA')).toBeUndefined();
      expect(parseOptionalGitCommitSha('', 'RAILWAY_GIT_COMMIT_SHA')).toBeUndefined();
    });

    it('rejects abbreviated, uppercase, and whitespace values without normalizing', () => {
      expect(() => parseOptionalGitCommitSha(INVALID_ABBREV, 'APP_COMMIT_SHA')).toThrow(
        /APP_COMMIT_SHA must be a full 40-character lowercase hexadecimal/,
      );
      expect(() => parseOptionalGitCommitSha(INVALID_UPPER, 'RAILWAY_GIT_COMMIT_SHA')).toThrow(
        /RAILWAY_GIT_COMMIT_SHA must be a full 40-character lowercase hexadecimal/,
      );
      expect(() => parseOptionalGitCommitSha(` ${COMMIT_A}`, 'APP_COMMIT_SHA')).toThrow(
        /APP_COMMIT_SHA must be a full 40-character lowercase hexadecimal/,
      );
    });
  });

  describe('resolveEffectiveCommitSha', () => {
    it('prefers Railway SHA when present', () => {
      expect(
        resolveEffectiveCommitSha({
          RAILWAY_GIT_COMMIT_SHA: COMMIT_A,
          APP_COMMIT_SHA: COMMIT_A,
        }),
      ).toBe(COMMIT_A);
      expect(resolveEffectiveCommitSha({ RAILWAY_GIT_COMMIT_SHA: COMMIT_A })).toBe(COMMIT_A);
    });

    it('falls back to APP_COMMIT_SHA', () => {
      expect(resolveEffectiveCommitSha({ APP_COMMIT_SHA: COMMIT_B })).toBe(COMMIT_B);
      expect(resolveEffectiveCommitSha({})).toBeUndefined();
    });
  });

  describe('loadEnv policy', () => {
    it('accepts Railway SHA only in production', () => {
      const env = loadEnv({
        APP_ENV: 'production',
        RAILWAY_GIT_COMMIT_SHA: COMMIT_A,
        DATABASE_URL: PROD_DATABASE_URL,
      });
      expect(env.RAILWAY_GIT_COMMIT_SHA).toBe(COMMIT_A);
      expect(env.APP_COMMIT_SHA).toBeUndefined();
      expect(resolveEffectiveCommitSha(env)).toBe(COMMIT_A);
    });

    it('accepts APP_COMMIT_SHA only in production (CI / non-Git fallback)', () => {
      const env = loadEnv({
        APP_ENV: 'production',
        APP_COMMIT_SHA: COMMIT_A,
        DATABASE_URL: PROD_DATABASE_URL,
      });
      expect(env.APP_COMMIT_SHA).toBe(COMMIT_A);
      expect(env.RAILWAY_GIT_COMMIT_SHA).toBeUndefined();
      expect(resolveEffectiveCommitSha(env)).toBe(COMMIT_A);
    });

    it('accepts both present and equal', () => {
      const env = loadEnv({
        APP_ENV: 'staging',
        RAILWAY_GIT_COMMIT_SHA: COMMIT_A,
        APP_COMMIT_SHA: COMMIT_A,
        DATABASE_URL: STG_DATABASE_URL,
      });
      expect(env.RAILWAY_GIT_COMMIT_SHA).toBe(COMMIT_A);
      expect(env.APP_COMMIT_SHA).toBe(COMMIT_A);
      expect(resolveEffectiveCommitSha(env)).toBe(COMMIT_A);
    });

    it('rejects both present and different', () => {
      expect(() =>
        loadEnv({
          APP_ENV: 'staging',
          RAILWAY_GIT_COMMIT_SHA: COMMIT_A,
          APP_COMMIT_SHA: COMMIT_B,
          DATABASE_URL: STG_DATABASE_URL,
        }),
      ).toThrow(/RAILWAY_GIT_COMMIT_SHA and APP_COMMIT_SHA must match exactly/);
    });

    it('rejects invalid RAILWAY_GIT_COMMIT_SHA', () => {
      expect(() =>
        loadEnv({
          APP_ENV: 'staging',
          RAILWAY_GIT_COMMIT_SHA: INVALID_ABBREV,
          DATABASE_URL: STG_DATABASE_URL,
        }),
      ).toThrow(/RAILWAY_GIT_COMMIT_SHA must be a full 40-character lowercase hexadecimal/);
    });

    it('rejects invalid APP_COMMIT_SHA', () => {
      expect(() =>
        loadEnv({
          APP_ENV: 'production',
          APP_COMMIT_SHA: INVALID_UPPER,
          DATABASE_URL: PROD_DATABASE_URL,
        }),
      ).toThrow(/APP_COMMIT_SHA must be a full 40-character lowercase hexadecimal/);
    });

    it('rejects missing identity in staging', () => {
      expect(() =>
        loadEnv({
          APP_ENV: 'staging',
          DATABASE_URL: STG_DATABASE_URL,
        }),
      ).toThrow(/missing deployment commit identity.*staging/);
    });

    it('rejects missing identity in production', () => {
      expect(() =>
        loadEnv({
          APP_ENV: 'production',
          DATABASE_URL: PROD_DATABASE_URL,
        }),
      ).toThrow(/missing deployment commit identity.*production/);
    });

    it('allows missing identity in development and test (intentional)', () => {
      const development = loadEnv({
        APP_ENV: 'development',
        DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
      });
      expect(resolveEffectiveCommitSha(development)).toBeUndefined();

      const testEnv = loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
      });
      expect(resolveEffectiveCommitSha(testEnv)).toBeUndefined();
    });

    it('keeps existing CI-style APP_COMMIT_SHA configuration valid', () => {
      // Mirrors .github/workflows/ci.yml: APP_COMMIT_SHA=${{ github.sha }}
      const env = loadEnv({
        NODE_ENV: 'test',
        APP_ENV: 'test',
        APP_COMMIT_SHA: COMMIT_A,
        DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
      });
      expect(env.APP_COMMIT_SHA).toBe(COMMIT_A);
      expect(resolveEffectiveCommitSha(env)).toBe(COMMIT_A);
    });
  });

  describe('build identity exposure', () => {
    it('reports the resolved Railway SHA as commitSha', () => {
      const env = createTestEnv({
        RAILWAY_GIT_COMMIT_SHA: COMMIT_A,
      });
      const identity = buildIdentityFromEnv(env);
      expect(identity.commitSha).toBe(COMMIT_A);
      const serialized = JSON.stringify(identity);
      expect(serialized).not.toMatch(/RAILWAY_GIT_COMMIT_SHA|APP_COMMIT_SHA|process\.env/i);
      expect(serialized).not.toMatch(/DATABASE_URL|postgres:|password|sk_|whsec_/i);
      expect(Object.keys(identity).sort()).toEqual(
        [
          'buildTimestamp',
          'commitSha',
          'environment',
          'expectedMigrationCount',
          'nodeVersion',
          'service',
          'version',
        ].sort(),
      );
    });

    it('does not expose both raw commit variables on the identity object', () => {
      const env = createTestEnv({
        RAILWAY_GIT_COMMIT_SHA: COMMIT_A,
        APP_COMMIT_SHA: COMMIT_A,
      });
      const identity = buildIdentityFromEnv(env);
      expect(identity).not.toHaveProperty('RAILWAY_GIT_COMMIT_SHA');
      expect(identity).not.toHaveProperty('APP_COMMIT_SHA');
      expect(identity.commitSha).toBe(COMMIT_A);
    });
  });
});
