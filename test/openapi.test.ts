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
