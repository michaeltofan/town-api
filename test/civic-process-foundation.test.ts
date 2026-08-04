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
const actionMigrationPath = new URL('../drizzle/0048_civic_action.sql', import.meta.url);
const verificationMigrationPath = new URL(
  '../drizzle/0049_civic_verification.sql',
  import.meta.url,
);
const proposalRoutePath = new URL('../src/routes/civic-proposals.ts', import.meta.url);
const deliberationRoutePath = new URL('../src/routes/civic-deliberation.ts', import.meta.url);
const votingRoutePath = new URL('../src/routes/civic-voting.ts', import.meta.url);
const mandateRoutePath = new URL('../src/routes/civic-mandate.ts', import.meta.url);
const mandateRepositoryPath = new URL('../src/db/repositories/civic-mandates.ts', import.meta.url);
const actionRoutePath = new URL('../src/routes/civic-action.ts', import.meta.url);
const verificationRoutePath = new URL('../src/routes/civic-verification.ts', import.meta.url);
const verificationRepositoryPath = new URL(
  '../src/db/repositories/civic-verification.ts',
  import.meta.url,
);
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

  it('opens action immediately once the mandate is decided, chained in the same transaction', async () => {
    const migration = await readFile(actionMigrationPath, 'utf8');

    expect(migration).toContain("'mandate_decided'");
    expect(migration).toContain("'stage_transitioned_to_action'");
    expect(migration).toContain(
      '"from_stage" = \'mandate\'\n      AND "to_stage" = \'action\'\n      AND "reason_key" = \'mandate_decided\'',
    );
    expect(migration).toContain('CREATE TABLE "town"."civic_action_updates"');
    expect(migration).not.toMatch(/operator|manual_transition/i);
    expect(migration).not.toMatch(/cron|pg_cron|scheduled job/i);
  });

  it('opens action only for a decided mandate; a contested mandate stays parked', async () => {
    const repository = await readFile(mandateRepositoryPath, 'utf8');

    expect(repository).toContain('if (!winnerProposalId) {\n      return;\n    }');
    expect(repository).toContain("'mandate_decided'");
    expect(repository).toContain("current_stage = 'action'");
    expect(repository).not.toMatch(/verification|archived/i);
  });

  it('scopes action status updates to any active community actor while action is open', async () => {
    const migration = await readFile(actionMigrationPath, 'utf8');
    const route = await readFile(actionRoutePath, 'utf8');

    expect(migration).toContain('"civic_action_updates_process_id_fkey"');
    expect(migration).toContain('"civic_action_updates_author_actor_id_fkey"');
    expect(migration).toContain("IF process_stage IS DISTINCT FROM 'action' THEN");
    expect(migration).toContain('actor_community_id IS DISTINCT FROM process_community_id');
    expect(route).toContain("app.get(\n    '/v1/signals/:signalId/civic-process/action'");
    expect(route).toContain("app.post(\n    '/v1/signals/:signalId/civic-process/action/updates'");
    expect(route).not.toMatch(/completionPercent|completionThreshold|progressPercent/i);
  });

  it('opens verification when any eligible actor marks a decided action ready, no threshold', async () => {
    const migration = await readFile(verificationMigrationPath, 'utf8');
    const route = await readFile(verificationRoutePath, 'utf8');
    const repository = await readFile(verificationRepositoryPath, 'utf8');

    expect(migration).toContain("'action_marked_ready'");
    expect(migration).toContain("'stage_transitioned_to_verification'");
    expect(migration).toContain(
      '"from_stage" = \'action\'\n      AND "to_stage" = \'verification\'\n      AND "reason_key" = \'action_marked_ready\'',
    );
    expect(route).toContain(
      "app.post(\n    '/v1/signals/:signalId/civic-process/verification/ready'",
    );
    const readyFn = /async function markActionReadyForVerification\([\s\S]*?\n}/.exec(repository);
    expect(!!readyFn).toBe(true);
    expect(readyFn?.[0]).not.toMatch(/count\(\*\)|>= 5|threshold/i);
  });

  it('archives verification with a symmetric 5-actor threshold for delivered vs not_delivered', async () => {
    const migration = await readFile(verificationMigrationPath, 'utf8');

    expect(migration).toContain("'verification_delivered_threshold_reached'");
    expect(migration).toContain("'verification_not_delivered_threshold_reached'");
    expect(migration).toContain('delivered_count >= 5');
    expect(migration).toContain('not_delivered_count >= 5');
    expect(migration).toContain('"civic_verification_confirmations_process_actor_unique"');
    expect(migration).toContain('UNIQUE ("process_id", "actor_id")');
    expect(migration).toContain('CREATE TABLE "town"."civic_verifications"');
    expect(migration).not.toMatch(/operator|manual_transition|coin.?flip|majority/i);
    expect(migration).not.toMatch(/cron|pg_cron|scheduled job/i);
  });

  it('scopes verification evidence and confirmations to an eligible actor while verification is open', async () => {
    const migration = await readFile(verificationMigrationPath, 'utf8');
    const route = await readFile(verificationRoutePath, 'utf8');

    expect(migration).toContain('"civic_verification_evidence_process_id_fkey"');
    expect(migration).toContain('"civic_verification_confirmations_process_id_fkey"');
    expect(migration).toContain("IF process_stage IS DISTINCT FROM 'verification' THEN");
    expect(migration).toContain('actor_community_id IS DISTINCT FROM process_community_id');
    expect(migration).toContain("LIKE 'http://%'");
    expect(route).toContain(
      "app.post(\n    '/v1/signals/:signalId/civic-process/verification/evidence'",
    );
    expect(route).toContain(
      "app.post(\n    '/v1/signals/:signalId/civic-process/verification/confirm'",
    );
    expect(route).not.toMatch(/completionPercent|completionThreshold|progressPercent/i);
  });

  it('reports a verification dispute honestly: no invented resolution when neither outcome reaches threshold', async () => {
    const route = await readFile(verificationRoutePath, 'utf8');

    expect(route).toContain('deliveredCount: verification?.deliveredCount ?? tally.deliveredCount');
    expect(route).toContain(
      'notDeliveredCount: verification?.notDeliveredCount ?? tally.notDeliveredCount',
    );
    expect(route).toContain('outcome: verification?.outcome ?? null');
    expect(route).not.toMatch(/coin.?flip|earliest.?vote|tiebreak(er)?\s*(rule|logic)/i);
  });

  it('reports action as a permanent public record: still readable once verification or archived', async () => {
    const route = await readFile(actionRoutePath, 'utf8');

    expect(route).toContain('hasReachedAction');
    expect(route).toContain("process.currentStage === 'verification' ||");
    expect(route).toContain("process.currentStage === 'archived'");
  });

  it('closes the civic-process lifecycle at archived with no invented next stage', async () => {
    const route = await readFile(routePath, 'utf8');

    expect(route).toContain(
      "process.currentStage === 'verification'\n                            ? 'archived'\n                            : null",
    );
    expect(route).toContain("'civic_process.stage.archived'");
  });

  it('exposes a read-only bounded endpoint without a state mutation surface', async () => {
    const route = await readFile(routePath, 'utf8');

    expect(route).toContain("app.get(\n    '/v1/signals/:signalId/civic-process'");
    expect(route).not.toMatch(/app\.(post|put|patch|delete)\(/);
    expect(route).not.toContain('denialReason');
    expect(route).toContain('listPublicCivicProcessEvents');
  });
});
