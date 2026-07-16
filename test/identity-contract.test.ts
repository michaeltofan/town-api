import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  generateIdentityContractDocument,
  serializeIdentityContract,
} from '../src/identity/contract/document.js';
import {
  FUTURE_IDENTITY_OPERATIONS,
  IDENTITY_ERROR_CODES,
} from '../src/identity/contract/schemas.js';

const contractPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../docs/account-identity-contract.v1.json',
);

describe('account identity architecture contract', () => {
  it('documents future operations without implying live routes', () => {
    const document = generateIdentityContractDocument() as {
      implementedLiveRoutes: boolean;
      futureOperations: { path: string }[];
      errorCodes: string[];
      forbiddenPublicErrorCodes: string[];
    };

    expect(document.implementedLiveRoutes).toBe(false);
    expect(document.futureOperations).toHaveLength(FUTURE_IDENTITY_OPERATIONS.length);
    expect(document.errorCodes).toEqual([...IDENTITY_ERROR_CODES]);
    expect(document.forbiddenPublicErrorCodes).toEqual(
      expect.arrayContaining([
        'EMAIL_NOT_FOUND',
        'EMAIL_ALREADY_REGISTERED',
        'ACCOUNT_EXISTS_FOR_EMAIL',
      ]),
    );
    expect(document.futureOperations.map((operation) => operation.path)).toContain(
      '/v1/account/passkeys',
    );
  });

  it('matches committed docs/account-identity-contract.v1.json', async () => {
    const generated = serializeIdentityContract(generateIdentityContractDocument());
    const committed = await readFile(contractPath, 'utf8');
    expect(generated).toBe(committed);
  });
});
