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
  it('documents ceremony semantics and implemented email, WebAuthn registration, authentication, and recovery routes', () => {
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
      webauthnRegistrationRuntime: { status: string; dependency: string };
      passkeyAuthenticationRuntime: { status: string; featureFlag: string };
      accountRecoveryRuntime: { status: string; featureFlag: string; routes: string[] };
    };

    expect(document.implementedLiveRoutes).toBe(true);
    expect(document.status).toBe('partially_implemented');
    expect(document.implementedRoutes).toEqual(
      expect.arrayContaining([
        'POST /v1/account/email-verifications',
        'POST /v1/account/email-verifications/complete',
        'POST /v1/account/passkeys/registration/options',
        'POST /v1/account/passkeys/registration/verify',
        'POST /v1/authentication/passkeys/options',
        'POST /v1/authentication/passkeys/verify',
        'GET /v1/authentication/session',
        'POST /v1/authentication/session/rotate',
        'POST /v1/authentication/logout',
        'POST /v1/authentication/logout-all',
        'POST /v1/account/recovery',
        'POST /v1/account/recovery/verify-email',
        'POST /v1/account/recovery/passkeys/registration/options',
        'POST /v1/account/recovery/passkeys/registration/verify',
        'GET /v1/account/passkeys',
        'POST /v1/account/security/reauthentication/passkeys/options',
        'POST /v1/account/security/reauthentication/passkeys/verify',
        'POST /v1/account/passkeys/add/options',
        'POST /v1/account/passkeys/add/verify',
        'PATCH /v1/account/passkeys/:passkeyId',
        'DELETE /v1/account/passkeys/:passkeyId',
      ]),
    );
    expect(document.accountSessions.idleTimeoutMinutes).toBe(60);
    expect(document.accountSessions.absoluteTimeoutHours).toBe(24);
    expect(document.accountSessions.sensitiveReauthFreshnessMinutes).toBe(10);
    expect(document.setupGrants.purpose).toEqual(['initial_passkey_registration']);
    expect(document.webauthnRegistrationRuntime.status).toBe('implemented');
    expect(document.webauthnRegistrationRuntime.dependency).toBe('@simplewebauthn/server@13.3.2');
    expect(document.passkeyAuthenticationRuntime.status).toBe('implemented');
    expect(document.passkeyAuthenticationRuntime.featureFlag).toBe(
      'PASSKEY_AUTHENTICATION_ENABLED',
    );
    expect(document.accountRecoveryRuntime.status).toBe('implemented');
    expect(document.accountRecoveryRuntime.featureFlag).toBe('ACCOUNT_RECOVERY_ENABLED');
    expect(document.accountRecoveryRuntime.routes).toHaveLength(4);
    expect(document.explicitExclusions).toEqual(
      expect.arrayContaining([
        'JWTs',
        'production email provider',
        'recovery login / session issuance from recovery',
        'membership',
      ]),
    );
    expect(document.explicitExclusions).not.toEqual(
      expect.arrayContaining([
        'cookies',
        'passkey login / authentication assertions',
        'recovery runtime',
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
        '/v1/account/passkeys/registration/options',
        '/v1/account/passkeys/registration/verify',
        '/v1/account/passkeys/add/options',
        '/v1/account/passkeys/add/verify',
        '/v1/authentication/passkeys/options',
        '/v1/authentication/passkeys/verify',
        '/v1/authentication/session',
        '/v1/authentication/session/rotate',
        '/v1/authentication/logout',
        '/v1/authentication/logout-all',
        '/v1/account/recovery',
        '/v1/account/recovery/verify-email',
        '/v1/account/recovery/passkeys/registration/options',
        '/v1/account/recovery/passkeys/registration/verify',
      ]),
    );
  });
});
