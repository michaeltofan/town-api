import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOpenApiDocument, serializeOpenApiDocument } from '../src/openapi/document.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openApiPath = path.join(rootDir, 'docs', 'openapi.v1.json');

async function generate(): Promise<void> {
  const document = await generateOpenApiDocument();
  const serialized = serializeOpenApiDocument(document);
  await mkdir(path.dirname(openApiPath), { recursive: true });
  await writeFile(openApiPath, serialized, 'utf8');
  process.stdout.write(`Wrote ${openApiPath}\n`);
}

async function check(): Promise<void> {
  const document = await generateOpenApiDocument();
  const generated = serializeOpenApiDocument(document);
  let committed: string;

  try {
    committed = await readFile(openApiPath, 'utf8');
  } catch {
    throw new Error(
      `Missing committed OpenAPI contract at ${openApiPath}. Run npm run openapi:generate.`,
    );
  }

  if (generated !== committed) {
    throw new Error(
      `OpenAPI contract drift detected. Generated document does not match ${openApiPath}. Run npm run openapi:generate.`,
    );
  }

  process.stdout.write(`OpenAPI contract matches ${openApiPath}\n`);
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

  throw new Error('Usage: tsx scripts/openapi.ts <generate|check>');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
