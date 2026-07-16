import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  generateAuthenticationCeremonyContractDocument,
  serializeAuthenticationCeremonyContract,
} from '../src/ceremony/contract/document.js';

const contractPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../docs/authentication-ceremony-foundation.v1.json',
);

const openApiPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../docs/openapi.v1.json',
);

describe('authentication ceremony architecture contract', () => {
  it('documents ceremony semantics and implemented email verification routes', () => {
    const document = generateAuthenticationCeremonyContractDocument() as {
      implementedLiveRoutes: boolean;
      status: string;
      implementedRoutes: string[];
      accountSessions: {
        idleTimeoutMinutes: number;
        absoluteTimeoutHours: number;
        sensitiveReauthFreshnessMinutes: number;
      };
      setupGrants: { purpose: string[] };
      explicitExclusions: string[];
    };

    expect(document.implementedLiveRoutes).toBe(true);
    expect(document.status).toBe('partially_implemented');
    expect(document.implementedRoutes).toEqual(
      expect.arrayContaining([
        'POST /v1/account/email-verifications',
        'POST /v1/account/email-verifications/complete',
      ]),
    );
    expect(document.accountSessions.idleTimeoutMinutes).toBe(60);
    expect(document.accountSessions.absoluteTimeoutHours).toBe(24);
    expect(document.accountSessions.sensitiveReauthFreshnessMinutes).toBe(10);
    expect(document.setupGrants.purpose).toEqual(['initial_passkey_registration']);
    expect(document.explicitExclusions).toEqual(
      expect.arrayContaining([
        'cookies',
        'JWTs',
        'WebAuthn options or verification',
        'login routes',
        'production email provider',
      ]),
    );
  });

  it('matches committed docs/authentication-ceremony-foundation.v1.json', async () => {
    const generated = serializeAuthenticationCeremonyContract(
      generateAuthenticationCeremonyContractDocument(),
    );
    const committed = await readFile(contractPath, 'utf8');
    expect(generated).toBe(committed);
  });

  it('does not add unimplemented authentication paths to live OpenAPI', async () => {
    const openapi = JSON.parse(await readFile(openApiPath, 'utf8')) as {
      paths: Record<string, unknown>;
    };
    const paths = Object.keys(openapi.paths);
    expect(paths).not.toEqual(
      expect.arrayContaining([
        '/v1/auth/login',
        '/v1/auth/logout',
        '/v1/account/sessions',
        '/v1/account/setup',
      ]),
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        '/health/live',
        '/health/ready',
        '/v1/communities',
        '/v1/signals/{signalId}/confirmation',
        '/v1/account/email-verifications',
        '/v1/account/email-verifications/complete',
      ]),
    );
  });
});
