import type { FastifyInstance } from 'fastify';

export type GracefulShutdownSignal = 'SIGINT' | 'SIGTERM';

export type GracefulShutdownOptions = {
  readonly timeoutMs: number;
  /**
   * Injected exit callback. Defaults to `process.exit`. Tests can override to
   * observe exit-code decisions without terminating the runner.
   */
  readonly onExit?: (code: number) => void;
  /**
   * Signal source. Defaults to Node's global `process`. Tests can inject a
   * fake event emitter to exercise handler wiring without touching real
   * signals.
   */
  readonly signalSource?: NodeJS.Process | GracefulShutdownEmitter;
};

export type GracefulShutdownEmitter = {
  once(signal: GracefulShutdownSignal, listener: () => void): unknown;
};

export type GracefulShutdownHandle = {
  /** True once a signal has begun the teardown sequence. */
  readonly isShuttingDown: () => boolean;
  /** Invoke teardown manually, exactly as if the signal fired. Safe to call multiple times. */
  readonly trigger: (signal: GracefulShutdownSignal) => Promise<void>;
};

const APP_SHUTDOWN_DECORATOR = 'isShuttingDown';

declare module 'fastify' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface FastifyInstance {
    isShuttingDown: boolean;
  }
}

function decorateShutdownFlag(app: FastifyInstance): void {
  if (!app.hasDecorator(APP_SHUTDOWN_DECORATOR)) {
    app.decorate(APP_SHUTDOWN_DECORATOR, false);
  }
}

/**
 * Install SIGTERM/SIGINT graceful-shutdown handlers on a Fastify app.
 *
 * Contract:
 * - Idempotent: only installs once per app instance; duplicate registration
 *   is a no-op (returns the existing handle).
 * - On signal: sets `app.isShuttingDown = true` immediately so /health/ready
 *   returns 503 before the HTTP server begins draining.
 * - Then closes the Fastify app (which fires onClose hooks including the DB
 *   pool close registered by the database plugin).
 * - Force-exits with code 1 if teardown does not resolve within `timeoutMs`.
 * - Exits with code 0 on clean teardown.
 * - Logs only bounded fields; never logs env, DATABASE_URL, or headers.
 */
export function installGracefulShutdown(
  app: FastifyInstance,
  options: GracefulShutdownOptions,
): GracefulShutdownHandle {
  decorateShutdownFlag(app);

  const existing = (app as unknown as { __townGracefulShutdown?: GracefulShutdownHandle })
    .__townGracefulShutdown;
  if (existing !== undefined) {
    return existing;
  }

  const onExit = options.onExit ?? ((code: number) => process.exit(code));
  const signalSource: GracefulShutdownEmitter = options.signalSource ?? process;

  let triggered = false;

  const trigger = async (signal: GracefulShutdownSignal): Promise<void> => {
    if (triggered) {
      return;
    }
    triggered = true;
    app.isShuttingDown = true;
    app.log.info({ signal, event: 'shutdown_started' }, 'graceful shutdown started');

    let forceExitTimer: NodeJS.Timeout | undefined;
    const forceExit = new Promise<'timeout'>((resolve) => {
      forceExitTimer = setTimeout(() => {
        resolve('timeout');
      }, options.timeoutMs);
    });
    if (forceExitTimer?.unref !== undefined) {
      forceExitTimer.unref();
    }

    let closeError: unknown;
    const closePromise = app
      .close()
      .then((): 'closed' => 'closed')
      .catch((error: unknown): 'closed' => {
        closeError = error;
        return 'closed';
      });

    const result = await Promise.race([closePromise, forceExit]);
    if (forceExitTimer !== undefined) {
      clearTimeout(forceExitTimer);
    }

    if (result === 'timeout') {
      app.log.warn(
        { signal, event: 'shutdown_timeout', timeoutMs: options.timeoutMs },
        'graceful shutdown timed out',
      );
      onExit(1);
      return;
    }

    if (closeError !== undefined) {
      app.log.error(
        { signal, event: 'shutdown_error' },
        'graceful shutdown encountered an error while closing app',
      );
      onExit(1);
      return;
    }

    app.log.info({ signal, event: 'shutdown_complete' }, 'graceful shutdown complete');
    onExit(0);
  };

  signalSource.once('SIGTERM', () => {
    void trigger('SIGTERM');
  });
  signalSource.once('SIGINT', () => {
    void trigger('SIGINT');
  });

  const handle: GracefulShutdownHandle = {
    isShuttingDown: () => app.isShuttingDown,
    trigger,
  };
  (app as unknown as { __townGracefulShutdown?: GracefulShutdownHandle }).__townGracefulShutdown =
    handle;
  return handle;
}
