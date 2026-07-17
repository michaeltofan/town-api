import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { buildIdentityFromEnv } from './ops/build-identity.js';
import { installGracefulShutdown } from './ops/graceful-shutdown.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp({ env });

  installGracefulShutdown(app, {
    timeoutMs: env.GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  });

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    const identity = buildIdentityFromEnv(env);
    app.log.info(
      {
        event: 'server_listening',
        environment: identity.environment,
        version: identity.version,
        commitSha: identity.commitSha,
        expectedMigrationCount: identity.expectedMigrationCount,
      },
      'server listening',
    );
  } catch (error) {
    app.log.error({ event: 'server_listen_failed' }, (error as Error).message);
    process.exit(1);
  }
}

void main();
