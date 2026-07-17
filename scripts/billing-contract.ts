import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateBillingContractDocument,
  serializeBillingContract,
} from '../src/billing/contract/document.js';

const contractPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../docs/billing-foundation.v1.json',
);

async function generate(): Promise<void> {
  const document = generateBillingContractDocument();
  const serialized = serializeBillingContract(document);
  await writeFile(contractPath, serialized, 'utf8');
  process.stdout.write(`Wrote ${contractPath}\n`);
}

async function check(): Promise<void> {
  const document = generateBillingContractDocument();
  const generated = serializeBillingContract(document);
  const committed = await readFile(contractPath, 'utf8');
  if (generated !== committed) {
    throw new Error('Billing contract differs from docs/billing-foundation.v1.json');
  }
  process.stdout.write('Billing contract matches docs/billing-foundation.v1.json\n');
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
  throw new Error('Usage: billing-contract.ts <generate|check>');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'billing contract command failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
