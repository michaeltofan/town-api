import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL('../drizzle/0041_civic_process_confirmation.sql', import.meta.url);
const thresholdMigrationPath = new URL(
  '../drizzle/0042_civic_process_confirmation_threshold.sql',
  import.meta.url,
);
const proposalMigrationPath = new URL(
  '../drizzle/0043_civic_process_proposals.sql',
  import.meta.url,
);
const proposalRoutePath = new URL('../src/routes/civic-proposals.ts', import.meta.url);
const routePath = new URL('../src/routes/civic-process.ts', import.meta.url);

describe('civic process confirmation foundation', () => {
  it('provisions exactly one confirmation process and initial event per signal', async () => {
    const migration = await readFile(migrationPath, 'utf8');

    expect(migration).toContain('"civic_processes_signal_id_unique" UNIQUE("signal_id")');
    expect(migration).toContain('"civic_process_events_process_type_unique"');
    expect(migration).toContain("'confirmation'");
    expect(migration).toContain("'process_created'");
    expect(migration).toContain('AFTER INSERT ON "town"."signals"');
    expect(migration).toContain('ON CONFLICT ("signal_id") DO NOTHING');
  });

  it('enforces community scope, append-only ledgers, and no direct stage change', async () => {
    const migration = await readFile(migrationPath, 'utf8');

    expect(migration).toContain('FOREIGN KEY ("signal_id", "community_id")');
    expect(migration).toContain('"civic_process_events_append_only"');
    expect(migration).toContain('"civic_process_transitions_append_only"');
    expect(migration).toContain('"civic_processes_no_direct_stage_change"');
  });

  it('advances exactly once at five confirmations through an audited database transition', async () => {
    const migration = await readFile(thresholdMigrationPath, 'utf8');

    expect(migration).toContain('confirmation_count < 5');
    expect(migration).toContain("'confirmation_threshold_reached'");
    expect(migration).toContain("'stage_transitioned_to_proposals'");
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('BEFORE INSERT ON "town"."signal_confirmations"');
    expect(migration).toContain('AFTER INSERT ON "town"."signal_confirmations"');
    expect(migration).not.toMatch(/operator|manual_transition/i);
  });

  it('enforces structured proposals only in the proposals stage and community', async () => {
    const migration = await readFile(proposalMigrationPath, 'utf8');
    const route = await readFile(proposalRoutePath, 'utf8');

    expect(migration).toContain('"civic_proposals_process_actor_unique"');
    expect(migration).toContain("'proposals'");
    expect(migration).toContain('actor_community_id IS DISTINCT FROM process_community_id');
    expect(route).toContain("app.get(\n    '/v1/signals/:signalId/civic-process/proposals'");
    expect(route).toContain("app.post(\n    '/v1/signals/:signalId/civic-process/proposals'");
    expect(route).not.toMatch(/voting|ballot|deliberation.*transition/i);
  });

  it('exposes a read-only bounded endpoint without a state mutation surface', async () => {
    const route = await readFile(routePath, 'utf8');

    expect(route).toContain("app.get(\n    '/v1/signals/:signalId/civic-process'");
    expect(route).not.toMatch(/app\.(post|put|patch|delete)\(/);
    expect(route).not.toContain('denialReason');
    expect(route).toContain('listPublicCivicProcessEvents');
  });
});
