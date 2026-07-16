import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateIdentityContractDocument,
  serializeIdentityContract,
} from '../src/identity/contract/document.js';

const contractPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../docs/account-identity-contract.v1.json',
);

async function generate(): Promise<void> {
  const document = generateIdentityContractDocument();
  const serialized = serializeIdentityContract(document);
  await writeFile(contractPath, serialized, 'utf8');
  process.stdout.write(`Wrote ${contractPath}\n`);
}

async function check(): Promise<void> {
  const document = generateIdentityContractDocument();
  const generated = serializeIdentityContract(document);
  const committed = await readFile(contractPath, 'utf8');
  if (generated !== committed) {
    throw new Error(
      'Identity architecture contract differs from docs/account-identity-contract.v1.json',
    );
  }
  process.stdout.write(
    'Identity architecture contract matches docs/account-identity-contract.v1.json\n',
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'generate') {
    await generate();
    return;
  }
  if (command === 'check') {
    await check();
    return;
  }
  throw new Error('Usage: identity-contract.ts <generate|check>');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'identity contract command failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
