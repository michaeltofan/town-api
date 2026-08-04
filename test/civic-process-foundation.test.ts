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
const proposalThresholdMigrationPath = new URL(
  '../drizzle/0044_civic_process_proposal_threshold.sql',
  import.meta.url,
);
const deliberationMigrationPath = new URL(
  '../drizzle/0045_civic_deliberation.sql',
  import.meta.url,
);
const votingMigrationPath = new URL('../drizzle/0046_civic_voting.sql', import.meta.url);
const mandateMigrationPath = new URL('../drizzle/0047_civic_mandate.sql', import.meta.url);
const proposalRoutePath = new URL('../src/routes/civic-proposals.ts', import.meta.url);
const deliberationRoutePath = new URL('../src/routes/civic-deliberation.ts', import.meta.url);
const votingRoutePath = new URL('../src/routes/civic-voting.ts', import.meta.url);
const mandateRoutePath = new URL('../src/routes/civic-mandate.ts', import.meta.url);
const mandateRepositoryPath = new URL('../src/db/repositories/civic-mandates.ts', import.meta.url);
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

  it('advances exactly once at five proposals through an audited database transition', async () => {
    const migration = await readFile(proposalThresholdMigrationPath, 'utf8');

    expect(migration).toContain('proposal_count < 5');
    expect(migration).toContain("'proposal_threshold_reached'");
    expect(migration).toContain("'stage_transitioned_to_deliberation'");
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('AFTER INSERT ON "town"."civic_proposals"');
    expect(migration).toContain("'proposal_threshold'");
    expect(migration).not.toMatch(/operator|manual_transition/i);
    expect(migration).not.toMatch(/voting|ballot/i);
  });

  it('scopes deliberation contributions to a proposal in the deliberation stage and community', async () => {
    const migration = await readFile(deliberationMigrationPath, 'utf8');
    const route = await readFile(deliberationRoutePath, 'utf8');

    expect(migration).toContain('"civic_deliberation_contributions_process_id_fkey"');
    expect(migration).toContain('"civic_deliberation_contributions_proposal_id_fkey"');
    expect(migration).toContain("'deliberation'");
    expect(migration).toContain('proposal_process_id IS DISTINCT FROM NEW."process_id"');
    expect(migration).toContain('actor_community_id IS DISTINCT FROM process_community_id');
    expect(route).toContain("app.get(\n    '/v1/signals/:signalId/civic-process/deliberation'");
    expect(route).toContain(
      "app.post(\n    '/v1/signals/:signalId/civic-process/deliberation/proposals/:proposalId/contributions'",
    );
    expect(route).not.toMatch(/vote_count|tally|civic_votes|winner|voting_closes_at/i);
  });

  it('advances exactly once at five distinct deliberation participants through an audited database transition', async () => {
    const migration = await readFile(deliberationMigrationPath, 'utf8');

    expect(migration).toContain('participant_count < 5');
    expect(migration).toContain("'deliberation_threshold_reached'");
    expect(migration).toContain("'stage_transitioned_to_ballot_preparation'");
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('count(DISTINCT "author_actor_id")');
    expect(migration).toContain('AFTER INSERT ON "town"."civic_deliberation_contributions"');
    expect(migration).toContain("'deliberation_threshold'");
    expect(migration).not.toMatch(/operator|manual_transition/i);
    expect(migration).not.toMatch(/voting|ballot.*(select|winner)/i);
  });

  it('opens voting immediately once the ballot is prepared, chained in the same transaction', async () => {
    const migration = await readFile(votingMigrationPath, 'utf8');

    expect(migration).toContain("'ballot_prepared'");
    expect(migration).toContain("'stage_transitioned_to_voting'");
    expect(migration).toContain(
      "'deliberation',\n    'ballot_preparation',\n    'deliberation_threshold_reached',",
    );
    expect(migration).toContain("'ballot_preparation',\n    'voting',\n    'ballot_prepared',");
    expect(migration).not.toMatch(/operator|manual_transition/i);
    expect(migration).not.toMatch(/quorum|plurality|majority/i);
  });

  it('scopes one vote per actor to a proposal in the voting stage and community', async () => {
    const migration = await readFile(votingMigrationPath, 'utf8');
    const route = await readFile(votingRoutePath, 'utf8');

    expect(migration).toContain('"civic_votes_process_actor_unique" UNIQUE');
    expect(migration).toContain("'voting'");
    expect(migration).toContain('proposal_process_id IS DISTINCT FROM NEW."process_id"');
    expect(migration).toContain('actor_community_id IS DISTINCT FROM process_community_id');
    expect(route).toContain("app.get(\n    '/v1/signals/:signalId/civic-process/voting'");
    expect(route).toContain("app.post(\n    '/v1/signals/:signalId/civic-process/voting/vote'");
    expect(route.toLowerCase()).toContain('not yet a secret ballot');
  });

  it('closes the voting window lazily and records an audited transition to mandate', async () => {
    const migration = await readFile(mandateMigrationPath, 'utf8');

    expect(migration).toContain('"voting_closes_at" timestamp with time zone');
    expect(migration).toContain("'voting_window_closed'");
    expect(migration).toContain("'stage_transitioned_to_mandate'");
    expect(migration).toContain(
      '"from_stage" = \'voting\'\n      AND "to_stage" = \'mandate\'\n      AND "reason_key" = \'voting_window_closed\'',
    );
    expect(migration).toContain('CREATE TABLE "town"."civic_mandates"');
    expect(migration).not.toMatch(/operator|manual_transition/i);
    expect(migration).not.toMatch(/cron|pg_cron|scheduled job/i);
  });

  it('closes the voting window in application code with row locking, no scheduled job', async () => {
    const repository = await readFile(mandateRepositoryPath, 'utf8');

    expect(repository).toContain('FOR UPDATE');
    expect(repository).toContain("current_stage !== 'voting'");
    expect(repository).toContain('tiedAtTop');
    expect(repository).toContain(
      'winnerProposalId = top && tiedAtTop === 1 ? top.proposal_id : null',
    );
    expect(repository).not.toMatch(/cron|pg_cron|node-cron|setInterval/i);
  });

  it('reports a perfect tie as contested with no invented tie-break rule', async () => {
    const route = await readFile(mandateRoutePath, 'utf8');

    expect(route).toContain("app.get(\n    '/v1/signals/:signalId/civic-process/mandate'");
    expect(route).toContain('contested: mandate !== null && mandate.proposalId === null');
    expect(route.toLowerCase()).toContain('no tie-break rule is invented');
    expect(route).not.toMatch(/coin.?flip|random|earliest.?vote|tiebreak(er)?\s*(rule|logic)/i);
  });

  it('exposes a read-only bounded endpoint without a state mutation surface', async () => {
    const route = await readFile(routePath, 'utf8');

    expect(route).toContain("app.get(\n    '/v1/signals/:signalId/civic-process'");
    expect(route).not.toMatch(/app\.(post|put|patch|delete)\(/);
    expect(route).not.toContain('denialReason');
    expect(route).toContain('listPublicCivicProcessEvents');
  });
});
