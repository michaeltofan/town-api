/**
 * Deployment smoke runner. Consumed both by the standalone
 * `scripts/smoke-deployment.ts` CLI and by unit tests (which inject a fake
 * `fetch` implementation to avoid touching the network).
 *
 * The runner performs a fixed, safe set of checks against a running instance:
 * transport (https unless localhost), /health/live shape, /health/ready
 * component shape, /health/build identity match, an unauthorized route
 * expecting 401, CORS unauthorized/authorized/null/preflight/no-origin,
 * and an invalid Stripe webhook signature. It never prints request/response
 * bodies verbatim; leaked secret sentinels short-circuit to failure.
 */

export type SmokeCheckStatus = 'passed' | 'failed' | 'skipped';

export type SmokeCheck = {
  readonly name: string;
  readonly status: SmokeCheckStatus;
  readonly detail?: string;
};

export type SmokeResult = {
  readonly ok: boolean;
  readonly baseUrl: string;
  readonly environment: string;
  readonly checks: SmokeCheck[];
};

export type SmokeOptions = {
  readonly baseUrl: string;
  readonly environment: string;
  readonly expectCommitSha?: string;
  readonly timeoutMs?: number;
  readonly authorizedOrigin?: string;
  readonly unauthorizedOrigin?: string;
  readonly fetchImpl?: typeof fetch;
};

const SECRET_SENTINELS = [
  'sk_live_',
  'whsec_',
  'sk_test_',
  'BEGIN PRIVATE KEY',
  'BEGIN RSA PRIVATE KEY',
];

function assertNoSecretLeakage(body: string): void {
  for (const sentinel of SECRET_SENTINELS) {
    if (body.includes(sentinel)) {
      throw new Error(`response body contains secret sentinel ${sentinel}`);
    }
  }
}

function isLocalHttpBaseUrl(baseUrl: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(baseUrl);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

async function readBounded(response: Response): Promise<string> {
  const text = await response.text();
  const bounded = text.slice(0, 4096);
  assertNoSecretLeakage(bounded);
  return bounded;
}

function assertOriginRejected(allow: string | null, origin: string, label: string): void {
  if (allow !== null && allow === origin) {
    throw new Error(`${label}: CORS allowed a rejected origin`);
  }
  if (allow === '*') {
    throw new Error(`${label}: CORS must not use wildcard origins`);
  }
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const checks: SmokeCheck[] = [];

  const runCheck = async (
    name: string,
    fn: () => Promise<string | undefined>,
    optional = false,
  ): Promise<void> => {
    try {
      const detail = await fn();
      checks.push(
        detail !== undefined ? { name, status: 'passed', detail } : { name, status: 'passed' },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({
        name,
        status: optional ? 'skipped' : 'failed',
        detail: message,
      });
    }
  };

  await runCheck('transport', () => {
    if (baseUrl.startsWith('https://')) {
      return Promise.resolve('https');
    }
    if (isLocalHttpBaseUrl(baseUrl)) {
      return Promise.resolve('http-localhost-allowed');
    }
    return Promise.reject(new Error('base URL must use https (unless targeting localhost)'));
  });

  await runCheck('health-live', async () => {
    const response = await withTimeout(
      fetchImpl(`${baseUrl}/health/live`, { method: 'GET' }),
      timeoutMs,
      'health-live',
    );
    if (response.status !== 200) {
      throw new Error(`unexpected status ${String(response.status)}`);
    }
    const body = await readBounded(response);
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { status?: unknown }).status !== 'ok'
    ) {
      throw new Error('unexpected live payload shape');
    }
    return 'ok';
  });

  await runCheck('health-ready', async () => {
    const response = await withTimeout(
      fetchImpl(`${baseUrl}/health/ready`, { method: 'GET' }),
      timeoutMs,
      'health-ready',
    );
    if (response.status !== 200 && response.status !== 503) {
      throw new Error(`unexpected status ${String(response.status)}`);
    }
    const body = await readBounded(response);
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('unexpected ready payload shape');
    }
    const status = (parsed as { status?: unknown }).status;
    if (status !== 'ready' && status !== 'not_ready') {
      throw new Error('unexpected ready status literal');
    }
    if (
      typeof (parsed as { checks?: unknown }).checks !== 'object' ||
      (parsed as { checks?: unknown }).checks === null
    ) {
      throw new Error('ready payload missing checks');
    }
    if (status !== 'ready') {
      throw new Error('service is not ready');
    }
    return 'ready';
  });

  await runCheck('health-build', async () => {
    const response = await withTimeout(
      fetchImpl(`${baseUrl}/health/build`, { method: 'GET' }),
      timeoutMs,
      'health-build',
    );
    if (response.status !== 200) {
      throw new Error(`unexpected status ${String(response.status)}`);
    }
    const body = await readBounded(response);
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { data?: unknown }).data !== 'object'
    ) {
      throw new Error('unexpected build payload shape');
    }
    const data = (parsed as { data: Record<string, unknown> }).data;
    if (data.service !== 'town-api') {
      throw new Error('build service mismatch');
    }
    if (data.environment !== options.environment) {
      throw new Error(
        `build environment ${String(data.environment)} did not match expected ${options.environment}`,
      );
    }
    if (options.expectCommitSha !== undefined && data.commitSha !== options.expectCommitSha) {
      throw new Error('build commitSha did not match expected value');
    }
    return typeof data.commitSha === 'string' ? data.commitSha : 'no-commit';
  });

  await runCheck('unauthorized-route', async () => {
    const response = await withTimeout(
      fetchImpl(`${baseUrl}/v1/account/membership`, { method: 'GET' }),
      timeoutMs,
      'unauthorized-route',
    );
    if (response.status !== 401) {
      throw new Error(`unexpected status ${String(response.status)}`);
    }
    const body = await readBounded(response);
    JSON.parse(body);
    return '401';
  });

  await runCheck('cors-no-origin', async () => {
    const response = await withTimeout(
      fetchImpl(`${baseUrl}/health/live`, { method: 'GET' }),
      timeoutMs,
      'cors-no-origin',
    );
    if (response.status !== 200) {
      throw new Error(`unexpected status ${String(response.status)}`);
    }
    const allow = response.headers.get('access-control-allow-origin');
    if (allow !== null) {
      throw new Error('no-Origin request must not receive Access-Control-Allow-Origin');
    }
    await readBounded(response);
    return 'ok';
  });

  await runCheck('cors-null-origin', async () => {
    const response = await withTimeout(
      fetchImpl(`${baseUrl}/health/live`, {
        method: 'GET',
        headers: { Origin: 'null' },
      }),
      timeoutMs,
      'cors-null-origin',
    );
    assertOriginRejected(response.headers.get('access-control-allow-origin'), 'null', 'null');
    return 'rejected';
  });

  await runCheck(
    'cors-unauthorized-origin',
    async () => {
      const origin = options.unauthorizedOrigin;
      if (origin === undefined || origin.length === 0) {
        throw new Error('no unauthorized origin provided');
      }
      const response = await withTimeout(
        fetchImpl(`${baseUrl}/health/live`, {
          method: 'GET',
          headers: { Origin: origin },
        }),
        timeoutMs,
        'cors-unauthorized-origin',
      );
      assertOriginRejected(response.headers.get('access-control-allow-origin'), origin, 'unauthorized');
      return 'rejected';
    },
    true,
  );

  await runCheck(
    'cors-authorized-origin',
    async () => {
      const origin = options.authorizedOrigin;
      if (origin === undefined || origin.length === 0) {
        throw new Error('no authorized origin provided');
      }
      const response = await withTimeout(
        fetchImpl(`${baseUrl}/health/live`, {
          method: 'GET',
          headers: { Origin: origin },
        }),
        timeoutMs,
        'cors-authorized-origin',
      );
      if (response.status !== 200) {
        throw new Error(`unexpected status ${String(response.status)}`);
      }
      const allow = response.headers.get('access-control-allow-origin');
      if (allow !== origin) {
        throw new Error(`expected Access-Control-Allow-Origin ${origin}, got ${String(allow)}`);
      }
      if (allow === '*') {
        throw new Error('CORS must not use wildcard origins');
      }
      const credentials = response.headers.get('access-control-allow-credentials');
      if (credentials !== 'true') {
        throw new Error('expected Access-Control-Allow-Credentials true');
      }
      await readBounded(response);
      return 'accepted';
    },
    true,
  );

  await runCheck(
    'cors-preflight',
    async () => {
      const origin = options.authorizedOrigin;
      if (origin === undefined || origin.length === 0) {
        throw new Error('no authorized origin provided for preflight');
      }
      const response = await withTimeout(
        fetchImpl(`${baseUrl}/health/live`, {
          method: 'OPTIONS',
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'content-type,authorization',
          },
        }),
        timeoutMs,
        'cors-preflight',
      );
      if (response.status !== 204 && response.status !== 200) {
        throw new Error(`unexpected preflight status ${String(response.status)}`);
      }
      const allow = response.headers.get('access-control-allow-origin');
      if (allow !== origin) {
        throw new Error(`preflight ACAO mismatch: ${String(allow)}`);
      }
      const methods = response.headers.get('access-control-allow-methods');
      if (methods === null || !methods.toUpperCase().includes('GET')) {
        throw new Error('preflight missing Allow-Methods');
      }
      const maxAge = response.headers.get('access-control-max-age');
      if (maxAge === null || Number.parseInt(maxAge, 10) <= 0) {
        throw new Error('preflight missing bounded Max-Age');
      }
      return 'ok';
    },
    true,
  );

  await runCheck('stripe-webhook-invalid-signature', async () => {
    const response = await withTimeout(
      fetchImpl(`${baseUrl}/v1/billing/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 't=0,v1=invalid',
        },
        body: '{"id":"evt_smoke","object":"event"}',
      }),
      timeoutMs,
      'stripe-webhook-invalid-signature',
    );
    if (response.status !== 400 && response.status !== 404) {
      throw new Error(`unexpected status ${String(response.status)}`);
    }
    if (response.status === 404) {
      return 'webhook-not-mounted';
    }
    await readBounded(response);
    return '400';
  });

  const ok = checks.every((check) => check.status !== 'failed');
  return {
    ok,
    baseUrl,
    environment: options.environment,
    checks,
  };
}
