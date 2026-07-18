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

describe('production compiled migration entrypoint', () => {
  it('declares a Node-only production migration command that does not use tsx', () => {
    const pkg = readPackageJson();
    expect(pkg.scripts['db:migrate:production']).toBe('node dist/scripts/db-migrate.js');
    expect(pkg.scripts['db:migrate:production']).not.toMatch(/tsx/);
    expect(pkg.scripts['db:migrate']).toBe('tsx scripts/db-migrate.ts');
    expect(pkg.devDependencies.tsx).toBeDefined();
  });

  it('compiles the migration entrypoint into dist/scripts/db-migrate.js', () => {
    execFileSync('npm', ['run', 'build'], {
      cwd: root,
      stdio: 'pipe',
      env: process.env,
    });

    const entrypoint = path.join(root, 'dist', 'scripts', 'db-migrate.js');
    expect(existsSync(entrypoint)).toBe(true);

    const compiled = readFileSync(entrypoint, 'utf8');
    expect(compiled).not.toMatch(/\btsx\b/);
    expect(compiled).toMatch(/runMigrationsCli|run-migrations/);

    // Prove the production command is executable with Node alone (no tsx).
    const env = { ...process.env };
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
      const err = error as { status?: number; stderr?: Buffer };
      expect(err.status).toBe(1);
      stderr = err.stderr?.toString('utf8') ?? '';
    }
    expect(failed).toBe(true);
    expect(stderr).toMatch(/DATABASE_URL is required for db:migrate/);
  });

  it('production image contract ships dist, drizzle, and never auto-migrates', () => {
    const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');

    expect(dockerfile).toMatch(/COPY --from=build[^\n]*\/app\/dist \.\/dist/);
    expect(dockerfile).toMatch(/COPY[^\n]*drizzle \.\/drizzle/);
    expect(dockerfile).toMatch(/COPY[^\n]*package\.json \.\/package\.json/);
    expect(dockerfile).toMatch(/CMD\s*\[\s*"node",\s*"dist\/server\.js"\s*\]/);

    expect(dockerfile).not.toMatch(/CMD[^\n]*(db:migrate|db-migrate)/);
    expect(dockerfile).not.toMatch(/RUN[^\n]*(db:migrate|db-migrate)/);
    expect(dockerfile).toMatch(/db:migrate:production|dist\/scripts\/db-migrate\.js/);
  });

  it('keeps migration logic in a single shared module used by both runners', () => {
    const shared = readFileSync(path.join(root, 'src', 'db', 'run-migrations.ts'), 'utf8');
    const productionEntrypoint = readFileSync(
      path.join(root, 'src', 'scripts', 'db-migrate.ts'),
      'utf8',
    );
    const localEntrypoint = readFileSync(path.join(root, 'scripts', 'db-migrate.ts'), 'utf8');

    expect(shared).toMatch(/pg_advisory_lock/);
    expect(shared).toMatch(/pg_advisory_unlock/);
    expect(shared).toMatch(/hashtext\('town-api-migrate'\)/);
    expect(shared).toMatch(/Migrations applied successfully/);

    expect(productionEntrypoint).toMatch(/runMigrationsCli/);
    expect(productionEntrypoint).not.toMatch(/pg_advisory_lock/);
    expect(localEntrypoint).toMatch(/runMigrationsCli/);
    expect(localEntrypoint).not.toMatch(/pg_advisory_lock/);
  });
});
