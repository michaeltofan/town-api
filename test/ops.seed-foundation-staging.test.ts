import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = path.join(root, 'dist', 'scripts', 'seed-foundation-staging.js');

function runEntrypoint(env: NodeJS.ProcessEnv): string {
  try {
    execFileSync(process.execPath, [entrypoint], {
      cwd: root,
      env,
      stdio: 'pipe',
    });
  } catch (error) {
    return (error as { stderr?: Buffer }).stderr?.toString('utf8') ?? '';
  }
  throw new Error('expected staging seed entrypoint to refuse before connecting');
}

describe('compiled staging foundation seed entrypoint', () => {
  it('declares a Node-only command and compiles the guarded entrypoint', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['db:seed:foundation:staging:production']).toBe(
      'node dist/scripts/seed-foundation-staging.js',
    );
    expect(pkg.scripts['db:seed:foundation:staging:production']).not.toMatch(/tsx/);

    execFileSync('npm', ['run', 'build'], {
      cwd: root,
      stdio: 'pipe',
      env: process.env,
    });

    expect(existsSync(entrypoint)).toBe(true);
    const compiled = readFileSync(entrypoint, 'utf8');
    expect(compiled).toMatch(/runFoundationSeedCli/);
    expect(compiled).toMatch(/requireAppEnv:\s*['"]staging['"]/);
  }, 60_000);

  it('refuses every environment except staging', () => {
    for (const appEnv of [undefined, 'production', 'development', 'test']) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
      };
      if (appEnv === undefined) {
        delete env.APP_ENV;
      } else {
        env.APP_ENV = appEnv;
      }
      expect(runEntrypoint(env)).toMatch(/APP_ENV_MISMATCH/);
    }
  }, 60_000);

  it('passes the staging guard and then refuses a missing database URL', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, APP_ENV: 'staging' };
    delete env.DATABASE_URL;
    const stderr = runEntrypoint(env);
    expect(stderr).not.toMatch(/APP_ENV_MISMATCH/);
    expect(stderr).toMatch(/DATABASE_URL_REQUIRED/);
  }, 60_000);

  it('uses the shared atomic runner that only imports communities and signals', () => {
    const runner = readFileSync(path.join(root, 'src', 'db', 'run-foundation-seed.ts'), 'utf8');
    expect(runner).toMatch(/db\.transaction/);
    expect(runner).toMatch(/seedFoundationContent/);
    const schemaImport = runner
      .split('\n')
      .find((line) => line.includes("from './schema.js'") && line.includes('{'));
    expect(schemaImport).toMatch(/\bcommunities\b/);
    expect(schemaImport).toMatch(/\bsignals\b/);
    expect(schemaImport).not.toMatch(/\bactors\b|\baccounts\b|\bsignalConfirmations\b/);
  });
});
