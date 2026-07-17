import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateOpenApiDocument, serializeOpenApiDocument } from '../src/openapi/document.js';

const openApiPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../docs/openapi.v1.json',
);

describe('OpenAPI contract', () => {
  it('generates valid OpenAPI 3.1 JSON with confirmation paths and temporary key scheme', async () => {
    const document = (await generateOpenApiDocument()) as {
      openapi: string;
      info: { title: string; version: string; description?: string };
      paths: Record<string, unknown>;
      components?: {
        securitySchemes?: Record<string, { name?: string; description?: string; type?: string }>;
      };
    };

    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('TOWN API');
    expect(document.info.version).toBe('0.1.0');
    expect(document.paths).toHaveProperty('/health/live');
    expect(document.paths).toHaveProperty('/health/ready');
    expect(document.paths).toHaveProperty('/health/build');
    expect(document.paths).toHaveProperty('/v1/communities');
    expect(document.paths).toHaveProperty('/v1/communities/{communitySlug}/signals');
    expect(document.paths).toHaveProperty('/v1/signals/{signalId}');
    expect(document.paths).toHaveProperty('/v1/signals/{signalId}/confirmation');
    expect(document.paths).toHaveProperty('/v1/account/email-verifications');
    expect(document.paths).toHaveProperty('/v1/account/email-verifications/complete');
    expect(document.paths).not.toHaveProperty('/docs');
    expect(document.paths).not.toHaveProperty('/health');
    expect(document.paths).not.toHaveProperty('/ready');

    const readyPath = document.paths['/health/ready'] as {
      get: { responses: Record<string, unknown> };
    };
    expect(readyPath.get.responses).toHaveProperty('200');
    expect(readyPath.get.responses).toHaveProperty('503');

    const buildPath = document.paths['/health/build'] as {
      get: { responses: Record<string, unknown> };
    };
    expect(buildPath.get.responses).toHaveProperty('200');

    const signalDetail = document.paths['/v1/signals/{signalId}'] as {
      get: { responses: Record<string, unknown> };
    };
    expect(signalDetail.get.responses).toHaveProperty('200');
    expect(signalDetail.get.responses).toHaveProperty('400');
    expect(signalDetail.get.responses).toHaveProperty('404');

    const confirmationPath = document.paths['/v1/signals/{signalId}/confirmation'] as {
      get: { responses: Record<string, unknown>; security?: unknown[] };
      put: {
        responses: Record<string, unknown>;
        requestBody?: unknown;
        security?: unknown[];
      };
    };
    expect(confirmationPath.get.responses).toHaveProperty('200');
    expect(confirmationPath.get.responses).toHaveProperty('400');
    expect(confirmationPath.get.responses).toHaveProperty('401');
    expect(confirmationPath.get.responses).toHaveProperty('403');
    expect(confirmationPath.get.responses).toHaveProperty('404');
    expect(confirmationPath.put.responses).toHaveProperty('200');
    expect(confirmationPath.put.responses).toHaveProperty('400');
    expect(confirmationPath.put.responses).toHaveProperty('401');
    expect(confirmationPath.put.responses).toHaveProperty('403');
    expect(confirmationPath.put.responses).toHaveProperty('404');

    const scheme = document.components?.securitySchemes?.TownControlKey;
    expect(scheme?.type).toBe('apiKey');
    expect(scheme?.name).toBe('X-TOWN-Control-Key');
    expect(scheme?.description?.toLowerCase()).toContain('temporary');
    expect(scheme?.description?.toLowerCase()).toContain('not public authentication');

    // Membership foundation: exactly one public membership route, no mutation routes.
    const membershipPaths = Object.keys(document.paths).filter((p) => p.includes('membership'));
    expect(membershipPaths).toEqual(['/v1/account/membership']);
    const membership = document.paths['/v1/account/membership'] as Record<string, unknown>;
    expect(membership.get).toBeDefined();
    expect(membership.post).toBeUndefined();
    expect(membership.put).toBeUndefined();
    expect(membership.patch).toBeUndefined();
    expect(membership.delete).toBeUndefined();

    // Billing foundation: exactly three public billing routes.
    const billingPaths = Object.keys(document.paths)
      .filter((p) => p.includes('/v1/billing'))
      .sort();
    expect(billingPaths).toEqual([
      '/v1/billing/checkout-session',
      '/v1/billing/customer-portal-session',
      '/v1/billing/stripe/webhook',
    ]);
    const checkout = document.paths['/v1/billing/checkout-session'] as Record<string, unknown>;
    expect(checkout.post).toBeDefined();
    expect(checkout.get).toBeUndefined();
    const portal = document.paths['/v1/billing/customer-portal-session'] as Record<string, unknown>;
    expect(portal.post).toBeDefined();
    expect(portal.get).toBeUndefined();
    const webhook = document.paths['/v1/billing/stripe/webhook'] as Record<string, unknown>;
    expect(webhook.post).toBeDefined();
    expect(webhook.get).toBeUndefined();

    // Billing security: session-authenticated for checkout/portal, no security for webhook (signature verified inline).
    const checkoutPost = checkout.post as { security?: unknown[] };
    const checkoutSecurity = JSON.stringify(checkoutPost.security ?? []);
    expect(checkoutSecurity).toContain('sessionAuth');
    expect(checkoutSecurity).toContain('mobileSessionAuth');
    expect(checkoutSecurity).not.toContain('TownControlKey');
    const portalPost = portal.post as { security?: unknown[] };
    const portalSecurity = JSON.stringify(portalPost.security ?? []);
    expect(portalSecurity).toContain('sessionAuth');
    expect(portalSecurity).toContain('mobileSessionAuth');
    expect(portalSecurity).not.toContain('TownControlKey');

    // Confirmation PUT is now session-authenticated (not TownControlKey).
    const confirmationSecurity = JSON.stringify(confirmationPath.put.security ?? []);
    expect(confirmationSecurity).toContain('sessionAuth');
    expect(confirmationSecurity).toContain('mobileSessionAuth');
    expect(confirmationSecurity).not.toContain('TownControlKey');
    // Confirmation GET remains TownControlKey controlled.
    const confirmationGetSecurity = JSON.stringify(confirmationPath.get.security ?? []);
    expect(confirmationGetSecurity).toContain('TownControlKey');

    const serialized = serializeOpenApiDocument(document);
    expect(() => JSON.parse(serialized) as unknown).not.toThrow();
    expect(serialized).not.toMatch(/DATABASE_URL|postgres:\/\/|\/users|\/admin/i);
    expect(serialized).not.toMatch(/replace-with-local|super-secret|CONTROLLED_CONFIRMATION_KEY=/i);
    expect(document.info.description?.toLowerCase()).toContain('not public authentication');
  });

  it('generated OpenAPI equals committed docs/openapi.v1.json', async () => {
    const document = await generateOpenApiDocument();
    const generated = serializeOpenApiDocument(document);
    const committed = await readFile(openApiPath, 'utf8');
    expect(generated).toBe(committed);
  });
});
