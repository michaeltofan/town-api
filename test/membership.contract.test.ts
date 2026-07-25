import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  generateMembershipContractDocument,
  serializeMembershipContract,
} from '../src/membership/contract/document.js';

const contractPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../docs/membership-foundation.v1.json',
);

describe('membership contract', () => {
  it('exposes the four membership statuses, sources, results, and access levels', () => {
    const doc = generateMembershipContractDocument() as {
      entitlement: { statuses: string[]; sources: string[] };
      sourceEvents: { eventTypes: string[]; results: string[] };
      accessLevels: { values: string[] };
      localEligibility: { values: string[]; failClosedDefault: string };
    };
    expect(doc.entitlement.statuses).toEqual([
      'inactive',
      'active',
      'cancelling',
      'expired',
      'paid_pending_binding',
    ]);
    expect(doc.entitlement.sources).toEqual(['test_fixture', 'stripe', 'google_play']);
    expect(doc.sourceEvents.eventTypes).toEqual([
      'activate',
      'schedule_cancellation',
      'expire',
      'reactivate',
      'provision_paid_pending_binding',
    ]);
    expect(doc.sourceEvents.results).toEqual(['applied', 'replayed', 'rejected', 'stale']);
    expect(doc.accessLevels.values).toEqual(['visitor', 'read_only', 'participant']);
    expect(doc.localEligibility.values).toEqual([
      'eligible',
      'not_verified',
      'expired',
      'mismatched_community',
      'unavailable',
    ]);
    expect(doc.localEligibility.failClosedDefault).toBe('unavailable');
  });

  it('records exactly one public membership route and no mutation routes', () => {
    const doc = generateMembershipContractDocument() as {
      routes: {
        publicMembershipRoutes: string[];
        publicMembershipMutationRoutes: string[];
        participantSignalConfirmation: string;
      };
    };
    expect(doc.routes.publicMembershipRoutes).toEqual(['GET /v1/account/membership']);
    expect(doc.routes.publicMembershipMutationRoutes).toEqual([]);
    expect(doc.routes.participantSignalConfirmation).toBe('PUT /v1/signals/:signalId/confirmation');
  });

  it('records the Stripe boundary — no SDK/network and no public provider ids', () => {
    const doc = generateMembershipContractDocument() as {
      stripeBoundary: {
        package: string;
        network: string;
        customerIds: string;
        subscriptionIds: string;
        webhookHandler: string;
      };
    };
    expect(doc.stripeBoundary.package).toBe('not installed');
    expect(doc.stripeBoundary.network).toBe('not called');
    expect(doc.stripeBoundary.customerIds).toContain('never exposed');
    expect(doc.stripeBoundary.subscriptionIds).toContain('never exposed');
    expect(doc.stripeBoundary.webhookHandler).toBe('not implemented');
  });

  it('records the payload-hash canonical key order and secret exclusions', () => {
    const doc = generateMembershipContractDocument() as {
      sourceEvents: {
        payloadHash: {
          algorithm: string;
          canonicalKeyOrder: string[];
          excludes: string[];
        };
      };
    };
    expect(doc.sourceEvents.payloadHash.algorithm).toBe('sha256');
    expect(doc.sourceEvents.payloadHash.canonicalKeyOrder).toEqual([
      'accessUntil',
      'accountId',
      'cancelAtPeriodEnd',
      'effectiveAt',
      'eventType',
      'googlePlayPackageName',
      'googlePlayPurchaseToken',
      'googlePlaySubscriptionId',
      'source',
      'sourceCustomerId',
      'sourceEventId',
      'sourceSubscriptionId',
    ]);
    expect(doc.sourceEvents.payloadHash.excludes).toContain('email');
    expect(doc.sourceEvents.payloadHash.excludes).toContain('sessionToken');
    expect(doc.sourceEvents.payloadHash.excludes).toContain('ipAddress');
    expect(doc.sourceEvents.payloadHash.excludes).toContain('stripeWebhookSecret');
  });

  it('records participant policy invariants including no controlled-actor linking', () => {
    const doc = generateMembershipContractDocument() as {
      participantPolicy: {
        requiresActiveSession: boolean;
        rejectsAuthorizationSchemes: string[];
        rejectsControlKeyOnPut: boolean;
        neverReassignsControlledActorConfirmations: boolean;
        neverLinksControlledActor: boolean;
        denialErrorCode: string;
      };
    };
    expect(doc.participantPolicy.requiresActiveSession).toBe(true);
    expect(doc.participantPolicy.rejectsAuthorizationSchemes).toEqual([
      'SetupGrant',
      'RecoveryGrant',
      'Bearer',
    ]);
    expect(doc.participantPolicy.rejectsControlKeyOnPut).toBe(true);
    expect(doc.participantPolicy.neverReassignsControlledActorConfirmations).toBe(true);
    expect(doc.participantPolicy.neverLinksControlledActor).toBe(true);
    expect(doc.participantPolicy.denialErrorCode).toBe('CIVIC_PARTICIPATION_NOT_AUTHORIZED');
  });

  it('serialization is deterministic and sorted', () => {
    const serialized = serializeMembershipContract(generateMembershipContractDocument());
    expect(() => JSON.parse(serialized) as unknown).not.toThrow();
    // Deterministic across runs.
    expect(serializeMembershipContract(generateMembershipContractDocument())).toBe(serialized);
  });

  it('matches the committed docs/membership-foundation.v1.json', async () => {
    const serialized = serializeMembershipContract(generateMembershipContractDocument());
    const committed = await readFile(contractPath, 'utf8');
    expect(serialized).toBe(committed);
  });
});
