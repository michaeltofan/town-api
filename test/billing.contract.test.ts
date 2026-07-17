import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  generateBillingContractDocument,
  serializeBillingContract,
} from '../src/billing/contract/document.js';

const contractPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../docs/billing-foundation.v1.json',
);

describe('Billing contract', () => {
  it('generated billing contract matches committed docs/billing-foundation.v1.json', async () => {
    const document = generateBillingContractDocument();
    const generated = serializeBillingContract(document);
    const committed = await readFile(contractPath, 'utf8');
    expect(generated).toBe(committed);
  });

  it('never leaks Stripe secret placeholders in the committed contract', async () => {
    const committed = await readFile(contractPath, 'utf8');
    expect(committed).not.toMatch(/sk_(test|live)_[a-zA-Z0-9_]{6,}/);
    expect(committed).not.toMatch(/whsec_[a-zA-Z0-9_]{6,}/);
  });

  it('documents the pinned Stripe SDK version and API version', async () => {
    const committed = await readFile(contractPath, 'utf8');
    expect(committed).toContain('"sdkVersion": "22.3.2"');
    expect(committed).toContain('"apiVersion": "2026-06-24.dahlia"');
  });

  it('documents only the three public billing routes', () => {
    const document = generateBillingContractDocument() as {
      routes: { publicBillingRoutes: string[] };
    };
    expect(document.routes.publicBillingRoutes.sort()).toEqual([
      'POST /v1/billing/checkout-session',
      'POST /v1/billing/customer-portal-session',
      'POST /v1/billing/stripe/webhook',
    ]);
  });
});
