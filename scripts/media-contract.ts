import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateMediaContractDocument,
  serializeMediaContract,
} from '../src/media/contract/document.js';

const contractPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../docs/media-foundation.v1.json',
);

async function generate(): Promise<void> {
  const document = generateMediaContractDocument();
  const serialized = serializeMediaContract(document);
  await writeFile(contractPath, serialized, 'utf8');
  process.stdout.write(`Wrote ${contractPath}\n`);
}

async function check(): Promise<void> {
  const document = generateMediaContractDocument();
  const generated = serializeMediaContract(document);
  const committed = await readFile(contractPath, 'utf8');
  if (generated !== committed) {
    throw new Error('Media contract differs from docs/media-foundation.v1.json');
  }
  process.stdout.write('Media contract matches docs/media-foundation.v1.json\n');
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
  throw new Error('Usage: media-contract.ts <generate|check>');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'media contract command failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
