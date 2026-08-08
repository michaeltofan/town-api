import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

describe('production compiled foundation seed entrypoint', () => {
  it('declares a Node-only production seed command that does not use tsx', () => {
    const pkg = readPackageJson();
    expect(pkg.scripts['db:seed:foundation:production']).toBe(
      'node dist/scripts/seed-foundation-content.js',
    );
    expect(pkg.scripts['db:seed:foundation:production']).not.toMatch(/tsx/);
    expect(pkg.scripts['db:seed:foundation']).toBe('tsx scripts/seed-foundation-content.ts');
    expect(pkg.devDependencies.tsx).toBeDefined();
  });

  it('compiles the foundation seed entrypoint and shared runner into dist/', () => {
    execFileSync('npm', ['run', 'build'], {
      cwd: root,
      stdio: 'pipe',
      env: process.env,
    });

    const entrypoint = path.join(root, 'dist', 'scripts', 'seed-foundation-content.js');
    expect(existsSync(entrypoint)).toBe(true);

    const compiled = readFileSync(entrypoint, 'utf8');
    expect(compiled).not.toMatch(/\btsx\b/);
    expect(compiled).toMatch(/runFoundationSeedCli/);
    expect(compiled).toMatch(/requireAppEnv:\s*['"]production['"]/);

    const sharedRunner = path.join(root, 'dist', 'db', 'run-foundation-seed.js');
    expect(existsSync(sharedRunner)).toBe(true);
    expect(readFileSync(sharedRunner, 'utf8')).toMatch(/seedFoundationContent/);
  }, 60_000);

  it('refuses to run when APP_ENV is not exactly production', () => {
    const entrypoint = path.join(root, 'dist', 'scripts', 'seed-foundation-content.js');
    for (const appEnv of [undefined, 'staging', 'development', 'test']) {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (appEnv === undefined) {
        delete env.APP_ENV;
      } else {
        env.APP_ENV = appEnv;
      }
      env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unused';
      let stderr = '';
      let failed = false;
      try {
        execFileSync(process.execPath, [entrypoint], { cwd: root, env, stdio: 'pipe' });
      } catch (error) {
        failed = true;
        const err = error as { stderr?: Buffer };
        stderr = err.stderr?.toString('utf8') ?? '';
      }
      expect(failed, `expected refusal for APP_ENV=${String(appEnv)}`).toBe(true);
      expect(stderr).toMatch(/APP_ENV_MISMATCH/);
    }
  }, 60_000);

  it('passes the environment gate under APP_ENV=production and fails only on missing DATABASE_URL', () => {
    const entrypoint = path.join(root, 'dist', 'scripts', 'seed-foundation-content.js');
    const env: NodeJS.ProcessEnv = { ...process.env, APP_ENV: 'production' };
    delete env.DATABASE_URL;
    let stderr = '';
    let failed = false;
    try {
      execFileSync(process.execPath, [entrypoint], { cwd: root, env, stdio: 'pipe' });
    } catch (error) {
      failed = true;
      const err = error as { stderr?: Buffer };
      stderr = err.stderr?.toString('utf8') ?? '';
    }
    expect(failed).toBe(true);
    expect(stderr).not.toMatch(/APP_ENV_MISMATCH/);
    expect(stderr).toMatch(/DATABASE_URL_REQUIRED/);
  }, 60_000);

  it('the dev/CI entrypoint declares no APP_ENV restriction', () => {
    const source = readFileSync(path.join(root, 'scripts', 'seed-foundation-content.ts'), 'utf8');
    expect(source).toMatch(/runFoundationSeedCli/);
    expect(source).not.toMatch(/requireAppEnv/);
  });

  it('the shared runner imports only the communities/signals schema tables', () => {
    const source = readFileSync(path.join(root, 'src', 'db', 'run-foundation-seed.ts'), 'utf8');
    expect(source).toMatch(/seedFoundationContent/);
    expect(source).toMatch(/db\.transaction/);
    const importLine = source
      .split('\n')
      .find((line) => line.includes("from './schema.js'") && line.includes('{'));
    expect(importLine).toBeTruthy();
    expect(importLine).toMatch(/\bcommunities\b/);
    expect(importLine).toMatch(/\bsignals\b/);
    expect(importLine).not.toMatch(/\baccounts\b|\bactors\b|\bsignalConfirmations\b/);
  });

  it('both entrypoints share the same runner instead of duplicating seed logic', () => {
    const devEntrypoint = readFileSync(
      path.join(root, 'scripts', 'seed-foundation-content.ts'),
      'utf8',
    );
    const productionEntrypoint = readFileSync(
      path.join(root, 'src', 'scripts', 'seed-foundation-content.ts'),
      'utf8',
    );
    expect(devEntrypoint).toMatch(/runFoundationSeedCli/);
    expect(productionEntrypoint).toMatch(/runFoundationSeedCli/);
    expect(devEntrypoint).not.toMatch(/seedFoundationContent/);
    expect(productionEntrypoint).not.toMatch(/seedFoundationContent/);
  });

  it('production image contract never auto-seeds foundation content on boot', () => {
    const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/CMD\s*\[\s*"node",\s*"dist\/server\.js"\s*\]/);
    expect(dockerfile).not.toMatch(/CMD[^\n]*(db:seed|seed-foundation)/);
    expect(dockerfile).not.toMatch(/RUN[^\n]*(db:seed|seed-foundation)/);
  });
});
