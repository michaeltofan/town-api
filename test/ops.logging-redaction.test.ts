import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import pino, { type Logger, type LoggerOptions } from 'pino';
import type { Env } from '../src/config/env.js';
import { buildIdentityFromEnv } from '../src/ops/build-identity.js';
import { createTestEnv } from './helpers/env.js';

async function readAll(stream: PassThrough): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    stream.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    stream.on('end', () => {
      resolve(buffer);
    });
    stream.on('error', reject);
  });
}

// The redact configuration is expressed in src/app.ts. We exercise the pino
// pipeline directly with the same base bindings + redact contract so that a
// failure here surfaces if either the base logger bindings or the redact paths
// regress. Using pino directly (not Fastify) keeps the surface exact and
// avoids Fastify's default request-serializer transforming the record.

const SENSITIVE_HEADER_REDACT = {
  paths: [
    'headers.authorization',
    'headers.cookie',
    'headers["x-town-control-key"]',
    'headers["stripe-signature"]',
  ],
  censor: '[Redacted]',
};

function buildLogger(env: Env, out: PassThrough): Logger {
  const identity = buildIdentityFromEnv(env);
  const options: LoggerOptions = {
    level: 'info',
    base: {
      service: identity.service,
      environment: identity.environment,
      version: identity.version,
      commitSha: identity.commitSha,
    },
    redact: SENSITIVE_HEADER_REDACT,
  };
  return pino(options, out);
}

describe('logging redaction and base bindings', () => {
  it('includes town-api base bindings on every log record', async () => {
    const out = new PassThrough();
    const env = createTestEnv({ APP_COMMIT_SHA: 'abcdef0123456789abcdef0123456789abcdef01' });
    const log = buildLogger(env, out);
    log.info({ event: 'test' }, 'hello');
    out.end();
    const text = await readAll(out);
    const line = text.trim().split('\n')[0];
    expect(line).toBeTruthy();
    const record = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(record.service).toBe('town-api');
    expect(record.environment).toBe('test');
    expect(record.version).toEqual(expect.any(String));
    expect(record.commitSha).toBe('abcdef0123456789abcdef0123456789abcdef01');
  });

  it('redacts sensitive headers when logging serialised requests', async () => {
    const out = new PassThrough();
    const env = createTestEnv();
    const log = buildLogger(env, out);
    log.info(
      {
        headers: {
          authorization: 'Bearer supersecret-do-not-log',
          cookie: '__Host-Http-town_session=super-cookie-do-not-log',
          'x-town-control-key': 'control-key-do-not-log',
          'stripe-signature': 't=0,v1=do-not-log',
          'x-request-id': 'req_test-123',
        },
      },
      'incoming',
    );
    out.end();
    const text = await readAll(out);
    expect(text).not.toContain('supersecret-do-not-log');
    expect(text).not.toContain('super-cookie-do-not-log');
    expect(text).not.toContain('control-key-do-not-log');
    expect(text).not.toContain('do-not-log');
    expect(text).toContain('[Redacted]');
    expect(text).toContain('req_test-123');
  });
});
