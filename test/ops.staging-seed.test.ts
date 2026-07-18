import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { StagingSeedError, runStagingSeed } from '../src/db/run-staging-seed.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readPackageJson(): {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
}

describe('production compiled staging seed entrypoint', () => {
  it('declares a Node-only production seed command that does not use tsx', () => {
    const pkg = readPackageJson();
    expect(pkg.scripts['db:seed:staging:production']).toBe('node dist/scripts/db-seed-staging.js');
    expect(pkg.scripts['db:seed:staging:production']).not.toMatch(/tsx/);
    expect(pkg.scripts['db:seed:staging']).toBe('tsx scripts/db-seed-staging.ts');
    expect(pkg.devDependencies.tsx).toBeDefined();
  });

  it('compiles the staging seed entrypoint into dist/scripts/db-seed-staging.js', () => {
    execFileSync('npm', ['run', 'build'], {
      cwd: root,
      stdio: 'pipe',
      env: process.env,
    });

    const entrypoint = path.join(root, 'dist', 'scripts', 'db-seed-staging.js');
    expect(existsSync(entrypoint)).toBe(true);

    const compiled = readFileSync(entrypoint, 'utf8');
    expect(compiled).not.toMatch(/\btsx\b/);
    expect(compiled).toMatch(/runStagingSeedCli|run-staging-seed/);

    const env: NodeJS.ProcessEnv = { ...process.env, APP_ENV: 'development' };
    delete env.DATABASE_URL;
    let failed = false;
    let stderr = '';
    try {
      execFileSync(process.execPath, [entrypoint], {
        cwd: root,
        env,
        stdio: 'pipe',
      });
    } catch (error) {
      failed = true;
      const err = error as { status?: number | null; stderr?: Buffer };
      expect(err.status).toBe(1);
      stderr = err.stderr?.toString('utf8') ?? '';
    }
    expect(failed).toBe(true);
    expect(stderr).toMatch(/APP_ENV_NOT_STAGING|APP_ENV=staging/);
  }, 60_000);

  it('production image contract documents the compiled seed entrypoint and never auto-seeds', () => {
    const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/db:seed:staging:production|dist\/scripts\/db-seed-staging\.js/);
    expect(dockerfile).toMatch(/CMD\s*\[\s*"node",\s*"dist\/server\.js"\s*\]/);
    expect(dockerfile).not.toMatch(/CMD[^\n]*(db:seed|db-seed-staging)/);
    expect(dockerfile).not.toMatch(/RUN[^\n]*(db:seed|db-seed-staging)/);
  });

  it('keeps seed orchestration in a shared module with staging-only and advisory-lock guards', () => {
    const shared = readFileSync(path.join(root, 'src', 'db', 'run-staging-seed.ts'), 'utf8');
    const productionEntrypoint = readFileSync(
      path.join(root, 'src', 'scripts', 'db-seed-staging.ts'),
      'utf8',
    );
    const localEntrypoint = readFileSync(path.join(root, 'scripts', 'db-seed-staging.ts'), 'utf8');

    expect(shared).toMatch(/pg_try_advisory_lock/);
    expect(shared).toMatch(/pg_advisory_unlock/);
    expect(shared).toMatch(/hashtext\('town-api-staging-seed'\)/);
    expect(shared).toMatch(/APP_ENV/);
    expect(shared).toMatch(/transaction/);
    expect(shared).not.toMatch(/hashtext\('town-api-migrate'\)/);

    expect(productionEntrypoint).toMatch(/runStagingSeedCli/);
    expect(productionEntrypoint).not.toMatch(/pg_try_advisory_lock/);
    expect(localEntrypoint).toMatch(/runStagingSeedCli/);
  });
});

describe('staging seed environment gate', () => {
  it('fails before mutation when APP_ENV is missing', async () => {
    await expect(
      runStagingSeed({
        env: { DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town' },
      }),
    ).rejects.toMatchObject({
      code: 'APP_ENV_NOT_STAGING',
    } satisfies Partial<StagingSeedError>);
  });

  it('fails before mutation when APP_ENV is production', async () => {
    await expect(
      runStagingSeed({
        env: {
          APP_ENV: 'production',
          DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
        },
      }),
    ).rejects.toMatchObject({ code: 'APP_ENV_NOT_STAGING' });
  });

  it('fails before mutation when APP_ENV is development', async () => {
    await expect(
      runStagingSeed({
        env: {
          APP_ENV: 'development',
          DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
        },
      }),
    ).rejects.toMatchObject({ code: 'APP_ENV_NOT_STAGING' });
  });

  it('fails before mutation when APP_ENV is test', async () => {
    await expect(
      runStagingSeed({
        env: {
          APP_ENV: 'test',
          DATABASE_URL: 'postgres://town:town@127.0.0.1:5432/town',
        },
      }),
    ).rejects.toMatchObject({ code: 'APP_ENV_NOT_STAGING' });
  });

  it('fails before mutation when DATABASE_URL is missing under staging', async () => {
    await expect(runStagingSeed({ env: { APP_ENV: 'staging' } })).rejects.toMatchObject({
      code: 'DATABASE_URL_REQUIRED',
    });
  });
});
