import { runSmoke, type SmokeOptions } from '../src/ops/smoke-runner.js';

type ParsedArgs = SmokeOptions & { readonly help?: boolean };

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = new Map<string, string>();
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (typeof key !== 'string') {
      i += 1;
      continue;
    }
    if (key === '--help' || key === '-h') {
      return {
        baseUrl: '',
        environment: '',
        help: true,
      };
    }
    if (!key.startsWith('--')) {
      i += 1;
      continue;
    }
    const value = argv[i + 1];
    if (typeof value !== 'string') {
      throw new Error(`missing value for ${key}`);
    }
    args.set(key.slice(2), value);
    i += 2;
  }

  const baseUrl = args.get('base-url');
  const environment = args.get('environment');
  if (baseUrl === undefined) {
    throw new Error('--base-url is required');
  }
  if (environment === undefined) {
    throw new Error('--environment is required');
  }
  const timeoutMsRaw = args.get('timeout-ms');
  const expectCommit = args.get('expect-commit');
  const authorizedOrigin = args.get('authorized-origin');
  const unauthorizedOrigin = args.get('unauthorized-origin');
  const authEnabledRaw = args.get('auth-enabled');
  let authEnabled: boolean | undefined;
  if (authEnabledRaw !== undefined) {
    const normalized = authEnabledRaw.trim().toLowerCase();
    if (normalized !== 'true' && normalized !== 'false') {
      throw new Error('--auth-enabled must be true or false');
    }
    authEnabled = normalized === 'true';
  }
  const parsed: ParsedArgs = {
    baseUrl,
    environment,
    ...(expectCommit !== undefined ? { expectCommitSha: expectCommit } : {}),
    ...(timeoutMsRaw !== undefined ? { timeoutMs: Number.parseInt(timeoutMsRaw, 10) } : {}),
    ...(authorizedOrigin !== undefined ? { authorizedOrigin } : {}),
    ...(unauthorizedOrigin !== undefined ? { unauthorizedOrigin } : {}),
    ...(authEnabled !== undefined ? { authEnabled } : {}),
  };
  return parsed;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: tsx scripts/smoke-deployment.ts \\',
      '  --base-url URL --environment ENV \\',
      '  [--expect-commit SHA] [--timeout-ms N] \\',
      '  [--authorized-origin URL] [--unauthorized-origin URL] \\',
      '  [--auth-enabled true|false]',
      '',
      'Runs a bounded set of deployment smoke checks against a running TOWN API.',
      'Emits a machine-readable JSON summary on the final line of stdout and',
      'exits non-zero on any failed check.',
      '',
      '--auth-enabled defaults to true (expect 401 on GET /v1/account/membership).',
      'Pass false when PASSKEY_AUTHENTICATION_ENABLED is off (expect 404).',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help === true) {
    printHelp();
    return;
  }
  const result = await runSmoke(parsed);
  for (const check of result.checks) {
    const line = `[${check.status.toUpperCase()}] ${check.name}${
      check.detail !== undefined ? `: ${check.detail}` : ''
    }`;
    process.stdout.write(`${line}\n`);
  }
  const summary = {
    ok: result.ok,
    baseUrl: result.baseUrl,
    environment: result.environment,
    checks: result.checks.map((check) => ({
      name: check.name,
      status: check.status,
      ...(check.detail !== undefined ? { detail: check.detail } : {}),
    })),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!result.ok) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'smoke:deployment failed';
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
