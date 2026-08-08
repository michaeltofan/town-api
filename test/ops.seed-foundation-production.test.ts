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

  it('compiles the foundation seed entrypoint into dist/scripts/seed-foundation-content.js', () => {
    execFileSync('npm', ['run', 'build'], {
      cwd: root,
      stdio: 'pipe',
      env: process.env,
    });

    const entrypoint = path.join(root, 'dist', 'scripts', 'seed-foundation-content.js');
    expect(existsSync(entrypoint)).toBe(true);

    const compiled = readFileSync(entrypoint, 'utf8');
    expect(compiled).not.toMatch(/\btsx\b/);
    expect(compiled).toMatch(/seedFoundationContent/);
  }, 60_000);

  it('runs under APP_ENV=production and does not refuse the way the staging seed runner does', () => {
    const entrypoint = path.join(root, 'dist', 'scripts', 'seed-foundation-content.js');
    const env: NodeJS.ProcessEnv = { ...process.env, APP_ENV: 'production' };
    delete env.DATABASE_URL;
    let stderr = '';
    let failed = false;
    try {
      execFileSync(process.execPath, [entrypoint], {
        cwd: root,
        env,
        stdio: 'pipe',
      });
    } catch (error) {
      failed = true;
      const err = error as { stderr?: Buffer };
      stderr = err.stderr?.toString('utf8') ?? '';
    }
    // Fails only because DATABASE_URL/other env config is missing in this
    // process — never because of an APP_ENV=staging-only refusal.
    expect(failed).toBe(true);
    expect(stderr).not.toMatch(/APP_ENV_NOT_STAGING/);
  }, 60_000);

  it('the source entrypoint imports only the communities/signals schema tables', () => {
    const source = readFileSync(
      path.join(root, 'src', 'scripts', 'seed-foundation-content.ts'),
      'utf8',
    );
    expect(source).toMatch(/seedFoundationContent/);
    const importLine = source.split('\n').find((line) => line.includes("from '../db/schema.js'"));
    expect(importLine).toBeTruthy();
    expect(importLine).toMatch(/\bcommunities\b/);
    expect(importLine).toMatch(/\bsignals\b/);
    expect(importLine).not.toMatch(/\baccounts\b|\bactors\b|\bsignalConfirmations\b/);
  });

  it('production image contract never auto-seeds foundation content on boot', () => {
    const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/CMD\s*\[\s*"node",\s*"dist\/server\.js"\s*\]/);
    expect(dockerfile).not.toMatch(/CMD[^\n]*(db:seed|seed-foundation)/);
    expect(dockerfile).not.toMatch(/RUN[^\n]*(db:seed|seed-foundation)/);
  });
});
