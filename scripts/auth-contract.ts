import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateAuthenticationCeremonyContractDocument,
  serializeAuthenticationCeremonyContract,
} from '../src/ceremony/contract/document.js';

const contractPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../docs/authentication-ceremony-foundation.v1.json',
);

async function generate(): Promise<void> {
  const document = generateAuthenticationCeremonyContractDocument();
  const serialized = serializeAuthenticationCeremonyContract(document);
  await writeFile(contractPath, serialized, 'utf8');
  process.stdout.write(`Wrote ${contractPath}\n`);
}

async function check(): Promise<void> {
  const document = generateAuthenticationCeremonyContractDocument();
  const generated = serializeAuthenticationCeremonyContract(document);
  const committed = await readFile(contractPath, 'utf8');
  if (generated !== committed) {
    throw new Error(
      'Authentication ceremony contract differs from docs/authentication-ceremony-foundation.v1.json',
    );
  }
  process.stdout.write(
    'Authentication ceremony contract matches docs/authentication-ceremony-foundation.v1.json\n',
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
  throw new Error('Usage: auth-contract.ts <generate|check>');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'auth contract command failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
