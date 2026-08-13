/** Shared STAGING-only safety gates for every loadtest/*.ts script. */

export function requireStagingEnv(env: NodeJS.ProcessEnv): void {
  const appEnv = (env.APP_ENV ?? '').trim().toLowerCase();
  if (appEnv === 'staging') return;
  throw new Error(
    `Refusing to run load-test tooling outside staging (APP_ENV=${JSON.stringify(env.APP_ENV)}).`,
  );
}

export function requireDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env.DATABASE_URL;
  if (!url || url.trim() === '') {
    throw new Error('DATABASE_URL is required (use railway run so private Postgres is injected)');
  }
  return url;
}
