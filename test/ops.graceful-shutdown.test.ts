import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  installGracefulShutdown,
  type GracefulShutdownEmitter,
} from '../src/ops/graceful-shutdown.js';

function createFakeSignalSource(): {
  emitter: EventEmitter;
  source: GracefulShutdownEmitter;
} {
  const emitter = new EventEmitter();
  const source: GracefulShutdownEmitter = {
    once(signal, listener) {
      emitter.once(signal, listener);
      return this;
    },
  };
  return { emitter, source };
}

describe('installGracefulShutdown', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    try {
      await app.close();
    } catch {
      /* already closed */
    }
  });

  it('decorates the app with isShuttingDown=false and installs handlers', () => {
    const { source } = createFakeSignalSource();
    const handle = installGracefulShutdown(app, {
      timeoutMs: 1000,
      onExit: () => {
        // no-op for construction test
      },
      signalSource: source,
    });
    expect(app.isShuttingDown).toBe(false);
    expect(handle.isShuttingDown()).toBe(false);
  });

  it('sets isShuttingDown=true immediately on SIGTERM and closes the app once', async () => {
    const { emitter, source } = createFakeSignalSource();
    const exits: number[] = [];
    const handle = installGracefulShutdown(app, {
      timeoutMs: 5000,
      onExit: (code) => {
        exits.push(code);
      },
      signalSource: source,
    });

    let closeCalls = 0;
    app.addHook('onClose', () => {
      closeCalls += 1;
      return Promise.resolve();
    });

    emitter.emit('SIGTERM');
    // Allow trigger microtasks to run to completion before assertion.
    await new Promise((resolve) => setImmediate(resolve));
    expect(handle.isShuttingDown()).toBe(true);
    expect(app.isShuttingDown).toBe(true);

    // Wait for close to finish.
    for (let i = 0; i < 20 && exits.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(exits).toEqual([0]);
    expect(closeCalls).toBe(1);
  });

  it('is idempotent when trigger is called twice', async () => {
    const { source } = createFakeSignalSource();
    const exits: number[] = [];
    const handle = installGracefulShutdown(app, {
      timeoutMs: 5000,
      onExit: (code) => {
        exits.push(code);
      },
      signalSource: source,
    });

    await handle.trigger('SIGTERM');
    await handle.trigger('SIGTERM');
    expect(exits).toEqual([0]);
  });

  it('returns the existing handle when installed twice', () => {
    const { source: source1 } = createFakeSignalSource();
    const { source: source2 } = createFakeSignalSource();
    const first = installGracefulShutdown(app, {
      timeoutMs: 1000,
      onExit: () => undefined,
      signalSource: source1,
    });
    const second = installGracefulShutdown(app, {
      timeoutMs: 1000,
      onExit: () => undefined,
      signalSource: source2,
    });
    expect(second).toBe(first);
  });

  it('exits with code 1 when teardown exceeds the timeout', async () => {
    const timeoutApp = Fastify({ logger: false });
    const { source } = createFakeSignalSource();
    const exits: number[] = [];
    let resolveHang: (() => void) | undefined;
    // Add an onClose hook that never resolves during the trigger race so the
    // force-exit timer wins. We resolve it in a finally block below so that
    // Fastify can eventually finish teardown for GC.
    timeoutApp.addHook(
      'onClose',
      () =>
        new Promise<void>((resolve) => {
          resolveHang = resolve;
        }),
    );
    try {
      const handle = installGracefulShutdown(timeoutApp, {
        timeoutMs: 25,
        onExit: (code) => {
          exits.push(code);
        },
        signalSource: source,
      });
      await handle.trigger('SIGTERM');
      expect(exits).toEqual([1]);
    } finally {
      resolveHang?.();
    }
  });
});
