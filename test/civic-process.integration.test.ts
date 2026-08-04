import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { FOUNDATION_SIGNAL_IDS } from '../src/db/seeds/foundation-content.js';
import { createSeededTestApp } from './helpers/pg.js';

// The /verification/ready endpoint requires a real session, which this
// integration harness does not set up (every other write in this file goes
// straight through the DB triggers). This mirrors exactly what
// markActionReadyForVerification does at the app layer, inside one explicit
// transaction so the set_config bypass is visible to the UPDATE it guards.
async function simulateActionMarkedReady(pool: Pool, processId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO town.civic_process_transitions
         (id, process_id, from_stage, to_stage, reason_key, occurred_at)
       VALUES (gen_random_uuid(), $1, 'action', 'verification', 'action_marked_ready', now())
       ON CONFLICT (process_id, from_stage, to_stage) DO NOTHING`,
      [processId],
    );
    await client.query(
      "SELECT set_config('town.civic_stage_transition', 'action_marked_ready', true)",
    );
    await client.query(
      `UPDATE town.civic_processes
       SET current_stage = 'verification', updated_at = now()
       WHERE id = $1 AND current_stage = 'action'`,
      [processId],
    );
    await client.query("SELECT set_config('town.civic_stage_transition', '', true)");
    await client.query(
      `INSERT INTO town.civic_process_events (id, process_id, event_type, occurred_at)
       VALUES (gen_random_uuid(), $1, 'stage_transitioned_to_verification', now())
       ON CONFLICT (process_id, event_type) DO NOTHING`,
      [processId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Drives a fresh process through confirmation, proposals, deliberation, and
// voting to a decided mandate with a clear winner (3 votes to 1), then closes
// voting lazily so it chains straight through mandate into action. Returns
// enough actors that verification-stage tests can reuse the same pool for
// their delivered/not_delivered confirmations.
async function buildDecidedProcessThroughAction(
  pool: Pool,
  app: Awaited<ReturnType<typeof createSeededTestApp>>['app'],
  input: { slug: string; position: number },
): Promise<{ signalId: string; processId: string; actorIds: string[]; winningProposalId: string }> {
  const signalId = randomUUID();
  const actorIds = Array.from({ length: 6 }, () => randomUUID());

  await pool.query(
    `INSERT INTO town.signals
     SELECT (jsonb_populate_record(
       NULL::town.signals,
       to_jsonb(source) || jsonb_build_object(
         'id', $1::uuid,
         'slug', $2::text,
         'position', $3::int,
         'created_at', now(),
         'updated_at', now(),
         'published_at', now()
       )
     )).*
     FROM town.signals source
     ORDER BY position
     LIMIT 1`,
    [signalId, input.slug, input.position],
  );

  for (const actorId of actorIds) {
    await pool.query(
      `INSERT INTO town.actors (
         id, kind, status, display_label, community_id, account_id,
         local_eligibility_verified_at, community_commitment_accepted_at,
         community_commitment_version, created_at, updated_at
       )
       SELECT
         $1::uuid, 'controlled_test', 'active', $1::text, community_id, NULL,
         NULL, NULL, NULL, now(), now()
       FROM town.signals
       WHERE id = $2`,
      [actorId, signalId],
    );
  }

  await Promise.all(
    actorIds.slice(0, 5).map((actorId) =>
      pool.query(
        `INSERT INTO town.signal_confirmations
           (id, signal_id, actor_id, confirmed_at, created_at)
         VALUES (gen_random_uuid(), $1, $2, now(), now())`,
        [signalId, actorId],
      ),
    ),
  );

  const processRow = await pool.query<{ id: string }>(
    'SELECT id FROM town.civic_processes WHERE signal_id = $1',
    [signalId],
  );
  const processId = processRow.rows[0]?.id;
  if (!processId) throw new Error('missing process id');

  await Promise.all(
    actorIds.slice(0, 5).map((actorId, index) =>
      pool.query(
        `INSERT INTO town.civic_proposals
           (id, process_id, author_actor_id, title, body, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
        [processId, actorId, `Verification proposal ${String(index)}`, `Body ${String(index)}`],
      ),
    ),
  );

  const proposalRows = await pool.query<{ id: string }>(
    'SELECT id FROM town.civic_proposals WHERE process_id = $1 ORDER BY created_at, id',
    [processId],
  );
  const proposalIds = proposalRows.rows.map((row) => row.id);
  const winningProposalId = proposalIds[0];
  const secondProposalId = proposalIds[1];
  if (!winningProposalId || !secondProposalId) throw new Error('missing proposal ids');

  await Promise.all(
    actorIds.slice(0, 5).map((actorId, index) =>
      pool.query(
        `INSERT INTO town.civic_deliberation_contributions
           (id, process_id, proposal_id, author_actor_id, intent, text, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'observation', $4, now())`,
        [
          processId,
          proposalIds[index],
          actorId,
          `Verification deliberation number ${String(index)}`,
        ],
      ),
    ),
  );

  await Promise.all([
    pool.query(
      `INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now())`,
      [processId, winningProposalId, actorIds[0]],
    ),
    pool.query(
      `INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now())`,
      [processId, winningProposalId, actorIds[1]],
    ),
    pool.query(
      `INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now())`,
      [processId, winningProposalId, actorIds[2]],
    ),
    pool.query(
      `INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now())`,
      [processId, secondProposalId, actorIds[3]],
    ),
  ]);

  await pool.query(
    "UPDATE town.civic_processes SET voting_closes_at = now() - interval '1 second' WHERE id = $1",
    [processId],
  );

  // The lazy voting-close (and its chain straight through mandate into
  // action) only runs as a side effect of a route touching the process, not
  // from raw SQL — so trigger it via the same public read every real caller
  // would use.
  const mandateResponse = await app.inject({
    method: 'GET',
    url: `/v1/signals/${signalId}/civic-process/mandate`,
  });
  if (mandateResponse.statusCode !== 200) {
    throw new Error('failed to lazily close voting while building fixture');
  }

  return { signalId, processId, actorIds, winningProposalId };
}

describe('civic process confirmation integration', () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof createSeededTestApp>>['app'];

  beforeAll(async () => {
    ({ app, pool } = await createSeededTestApp());
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('provisions exactly one confirmation process and process_created event per seeded signal', async () => {
    const counts = await pool.query<{
      signals: string;
      processes: string;
      events: string;
      transitions: string;
    }>(`SELECT
      (SELECT count(*)::text FROM town.signals) AS signals,
      (SELECT count(*)::text FROM town.civic_processes) AS processes,
      (SELECT count(*)::text FROM town.civic_process_events) AS events,
      (SELECT count(*)::text FROM town.civic_process_transitions) AS transitions`);

    expect(counts.rows[0]).toMatchObject({
      signals: counts.rows[0]?.processes,
      processes: counts.rows[0]?.events,
      transitions: '0',
    });

    const invalid = await pool.query<{
      count: string;
    }>(`SELECT count(*)::text AS count
      FROM town.civic_processes p
      JOIN town.signals s ON s.id = p.signal_id
      WHERE p.community_id <> s.community_id
         OR p.current_stage NOT IN ('confirmation', 'proposals', 'deliberation', 'ballot_preparation', 'voting')`);
    expect(invalid.rows[0]?.count).toBe('0');
  });

  it('provisions a process and event transactionally for a newly inserted signal', async () => {
    const signalId = randomUUID();
    await pool.query(
      `INSERT INTO town.signals
       SELECT (jsonb_populate_record(
         NULL::town.signals,
         to_jsonb(source) || jsonb_build_object(
           'id', $1::uuid,
           'slug', 'civic-process-trigger-test',
           'position', 32000,
           'created_at', now(),
           'updated_at', now(),
           'published_at', now()
         )
       )).*
       FROM town.signals source
       ORDER BY position
       LIMIT 1`,
      [signalId],
    );

    const rows = await pool.query<{
      stage: string;
      event_type: string;
      event_count: string;
    }>(
      `SELECT p.current_stage AS stage, min(e.event_type) AS event_type,
              count(e.id)::text AS event_count
       FROM town.civic_processes p
       JOIN town.civic_process_events e ON e.process_id = p.id
       WHERE p.signal_id = $1
       GROUP BY p.current_stage`,
      [signalId],
    );
    expect(rows.rows).toEqual([
      {
        stage: 'confirmation',
        event_type: 'process_created',
        event_count: '1',
      },
    ]);
  });

  it('rejects duplicate provisioning, ledger mutation, and direct stage changes', async () => {
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;
    const process = await pool.query<{ id: string; community_id: string }>(
      'SELECT id, community_id FROM town.civic_processes WHERE signal_id = $1',
      [signalId],
    );
    const row = process.rows[0];
    expect(row).toBeDefined();
    if (!row) return;

    await expect(
      pool.query(
        `INSERT INTO town.civic_processes
          (id, signal_id, community_id, current_stage, created_at, updated_at)
         VALUES ($1, $2, $3, 'confirmation', now(), now())`,
        [randomUUID(), signalId, row.community_id],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query('UPDATE town.civic_process_events SET occurred_at = now() WHERE process_id = $1', [
        row.id,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("UPDATE town.civic_processes SET current_stage = 'proposals' WHERE id = $1", [
        row.id,
      ]),
    ).rejects.toThrow();
  });

  it('returns a bounded truthful public process without identity data', async () => {
    const signalId = FOUNDATION_SIGNAL_IDS.milanoSignal1;
    const response = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        signalId,
        currentStage: 'confirmation',
        stageLabelKey: 'civic_process.stage.confirmation',
        confirmationCount: 0,
        hasConfirmed: false,
        canConfirm: false,
        nextStage: 'proposals',
        closingAt: null,
        transitionRule: {
          type: 'confirmation_count',
          requiredConfirmations: 5,
          reached: false,
        },
        timeline: [{ type: 'process_created' }],
      },
    });
    expect(response.body).not.toMatch(/accountId|actorId|email|providerId|denialReason/);
  });

  it('advances once when five confirmations arrive concurrently and closes confirmation', async () => {
    const signalId = randomUUID();
    const actorIds = Array.from({ length: 6 }, () => randomUUID());

    await pool.query(
      `INSERT INTO town.signals
       SELECT (jsonb_populate_record(
         NULL::town.signals,
         to_jsonb(source) || jsonb_build_object(
           'id', $1::uuid,
           'slug', 'civic-process-threshold-test',
           'position', 32001,
           'created_at', now(),
           'updated_at', now(),
           'published_at', now()
         )
       )).*
       FROM town.signals source
       ORDER BY position
       LIMIT 1`,
      [signalId],
    );

    for (const actorId of actorIds) {
      await pool.query(
        `INSERT INTO town.actors (
           id, kind, status, display_label, community_id, account_id,
           local_eligibility_verified_at, community_commitment_accepted_at,
           community_commitment_version, created_at, updated_at
         )
         SELECT
           $1::uuid, 'controlled_test', 'active', $1::text, community_id, NULL,
           NULL, NULL, NULL, now(), now()
         FROM town.signals
         WHERE id = $2`,
        [actorId, signalId],
      );
    }

    await Promise.all(
      actorIds.slice(0, 5).map((actorId) =>
        pool.query(
          `INSERT INTO town.signal_confirmations
             (id, signal_id, actor_id, confirmed_at, created_at)
           VALUES (gen_random_uuid(), $1, $2, now(), now())`,
          [signalId, actorId],
        ),
      ),
    );

    const state = await pool.query<{
      current_stage: string;
      transitions: string;
      transition_events: string;
    }>(
      `SELECT
         process.current_stage,
         (SELECT count(*)::text
          FROM town.civic_process_transitions transition
          WHERE transition.process_id = process.id) AS transitions,
         (SELECT count(*)::text
          FROM town.civic_process_events event
          WHERE event.process_id = process.id
            AND event.event_type = 'stage_transitioned_to_proposals') AS transition_events
       FROM town.civic_processes process
       WHERE process.signal_id = $1`,
      [signalId],
    );
    expect(state.rows).toEqual([
      { current_stage: 'proposals', transitions: '1', transition_events: '1' },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        currentStage: 'proposals',
        stageLabelKey: 'civic_process.stage.proposals',
        confirmationCount: 5,
        proposalCount: 0,
        canConfirm: false,
        nextStage: 'deliberation',
        transitionRule: {
          type: 'proposal_count',
          requiredProposals: 5,
          reached: false,
        },
        timeline: [{ type: 'process_created' }, { type: 'stage_transitioned_to_proposals' }],
      },
    });

    await expect(
      pool.query(
        `INSERT INTO town.signal_confirmations
           (id, signal_id, actor_id, confirmed_at, created_at)
         VALUES (gen_random_uuid(), $1, $2, now(), now())`,
        [signalId, actorIds[5]],
      ),
    ).rejects.toThrow(/civic confirmation stage is closed/);
  });

  it('advances once when five proposals arrive concurrently and closes proposals', async () => {
    const signalId = randomUUID();
    const actorIds = Array.from({ length: 6 }, () => randomUUID());

    await pool.query(
      `INSERT INTO town.signals
       SELECT (jsonb_populate_record(
         NULL::town.signals,
         to_jsonb(source) || jsonb_build_object(
           'id', $1::uuid,
           'slug', 'civic-process-proposal-threshold-test',
           'position', 32002,
           'created_at', now(),
           'updated_at', now(),
           'published_at', now()
         )
       )).*
       FROM town.signals source
       ORDER BY position
       LIMIT 1`,
      [signalId],
    );

    for (const actorId of actorIds) {
      await pool.query(
        `INSERT INTO town.actors (
           id, kind, status, display_label, community_id, account_id,
           local_eligibility_verified_at, community_commitment_accepted_at,
           community_commitment_version, created_at, updated_at
         )
         SELECT
           $1::uuid, 'controlled_test', 'active', $1::text, community_id, NULL,
           NULL, NULL, NULL, now(), now()
         FROM town.signals
         WHERE id = $2`,
        [actorId, signalId],
      );
    }

    await Promise.all(
      actorIds.slice(0, 5).map((actorId) =>
        pool.query(
          `INSERT INTO town.signal_confirmations
             (id, signal_id, actor_id, confirmed_at, created_at)
           VALUES (gen_random_uuid(), $1, $2, now(), now())`,
          [signalId, actorId],
        ),
      ),
    );

    const processRow = await pool.query<{ id: string; current_stage: string }>(
      'SELECT id, current_stage FROM town.civic_processes WHERE signal_id = $1',
      [signalId],
    );
    const processId = processRow.rows[0]?.id;
    expect(processRow.rows[0]?.current_stage).toBe('proposals');
    if (!processId) return;

    await Promise.all(
      actorIds.slice(0, 5).map((actorId, index) =>
        pool.query(
          `INSERT INTO town.civic_proposals
             (id, process_id, author_actor_id, title, body, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
          [processId, actorId, `Proposal ${String(index)}`, `Body ${String(index)}`],
        ),
      ),
    );

    const state = await pool.query<{
      current_stage: string;
      transitions: string;
      transition_events: string;
    }>(
      `SELECT
         process.current_stage,
         (SELECT count(*)::text
          FROM town.civic_process_transitions transition
          WHERE transition.process_id = process.id
            AND transition.from_stage = 'proposals'
            AND transition.to_stage = 'deliberation') AS transitions,
         (SELECT count(*)::text
          FROM town.civic_process_events event
          WHERE event.process_id = process.id
            AND event.event_type = 'stage_transitioned_to_deliberation') AS transition_events
       FROM town.civic_processes process
       WHERE process.signal_id = $1`,
      [signalId],
    );
    expect(state.rows).toEqual([
      { current_stage: 'deliberation', transitions: '1', transition_events: '1' },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        currentStage: 'deliberation',
        stageLabelKey: 'civic_process.stage.deliberation',
        confirmationCount: 5,
        proposalCount: 5,
        deliberationParticipantCount: 0,
        nextStage: 'ballot_preparation',
        transitionRule: {
          type: 'deliberation_participation_count',
          requiredParticipants: 5,
          reached: false,
        },
        timeline: [
          { type: 'process_created' },
          { type: 'stage_transitioned_to_proposals' },
          { type: 'stage_transitioned_to_deliberation' },
        ],
      },
    });

    await expect(
      pool.query(
        `INSERT INTO town.civic_proposals
           (id, process_id, author_actor_id, title, body, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'Late proposal', 'Body', now())`,
        [processId, actorIds[5]],
      ),
    ).rejects.toThrow(/civic proposal stage is closed/);
  });

  it('advances through ballot_preparation into voting immediately, closes deliberation, and tallies one vote per actor', async () => {
    const signalId = randomUUID();
    const actorIds = Array.from({ length: 6 }, () => randomUUID());

    await pool.query(
      `INSERT INTO town.signals
       SELECT (jsonb_populate_record(
         NULL::town.signals,
         to_jsonb(source) || jsonb_build_object(
           'id', $1::uuid,
           'slug', 'civic-process-deliberation-threshold-test',
           'position', 32003,
           'created_at', now(),
           'updated_at', now(),
           'published_at', now()
         )
       )).*
       FROM town.signals source
       ORDER BY position
       LIMIT 1`,
      [signalId],
    );

    for (const actorId of actorIds) {
      await pool.query(
        `INSERT INTO town.actors (
           id, kind, status, display_label, community_id, account_id,
           local_eligibility_verified_at, community_commitment_accepted_at,
           community_commitment_version, created_at, updated_at
         )
         SELECT
           $1::uuid, 'controlled_test', 'active', $1::text, community_id, NULL,
           NULL, NULL, NULL, now(), now()
         FROM town.signals
         WHERE id = $2`,
        [actorId, signalId],
      );
    }

    await Promise.all(
      actorIds.slice(0, 5).map((actorId) =>
        pool.query(
          `INSERT INTO town.signal_confirmations
             (id, signal_id, actor_id, confirmed_at, created_at)
           VALUES (gen_random_uuid(), $1, $2, now(), now())`,
          [signalId, actorId],
        ),
      ),
    );

    const processRow = await pool.query<{ id: string; current_stage: string }>(
      'SELECT id, current_stage FROM town.civic_processes WHERE signal_id = $1',
      [signalId],
    );
    const processId = processRow.rows[0]?.id;
    expect(processRow.rows[0]?.current_stage).toBe('proposals');
    if (!processId) return;

    await Promise.all(
      actorIds.slice(0, 5).map((actorId, index) =>
        pool.query(
          `INSERT INTO town.civic_proposals
             (id, process_id, author_actor_id, title, body, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
          [processId, actorId, `Proposal ${String(index)}`, `Body ${String(index)}`],
        ),
      ),
    );

    const proposalRows = await pool.query<{ id: string }>(
      'SELECT id FROM town.civic_proposals WHERE process_id = $1 ORDER BY created_at, id',
      [processId],
    );
    const proposalIds = proposalRows.rows.map((row) => row.id);
    expect(proposalIds).toHaveLength(5);

    const stageAfterProposals = await pool.query<{ current_stage: string }>(
      'SELECT current_stage FROM town.civic_processes WHERE id = $1',
      [processId],
    );
    expect(stageAfterProposals.rows[0]?.current_stage).toBe('deliberation');

    await Promise.all(
      actorIds.slice(0, 5).map((actorId, index) =>
        pool.query(
          `INSERT INTO town.civic_deliberation_contributions
             (id, process_id, proposal_id, author_actor_id, intent, text, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'observation', $4, now())`,
          [
            processId,
            proposalIds[index],
            actorId,
            `Deliberation contribution number ${String(index)}`,
          ],
        ),
      ),
    );

    const state = await pool.query<{
      current_stage: string;
      ballot_transitions: string;
      ballot_events: string;
      voting_transitions: string;
      voting_events: string;
    }>(
      `SELECT
         process.current_stage,
         (SELECT count(*)::text
          FROM town.civic_process_transitions transition
          WHERE transition.process_id = process.id
            AND transition.from_stage = 'deliberation'
            AND transition.to_stage = 'ballot_preparation') AS ballot_transitions,
         (SELECT count(*)::text
          FROM town.civic_process_events event
          WHERE event.process_id = process.id
            AND event.event_type = 'stage_transitioned_to_ballot_preparation') AS ballot_events,
         (SELECT count(*)::text
          FROM town.civic_process_transitions transition
          WHERE transition.process_id = process.id
            AND transition.from_stage = 'ballot_preparation'
            AND transition.to_stage = 'voting') AS voting_transitions,
         (SELECT count(*)::text
          FROM town.civic_process_events event
          WHERE event.process_id = process.id
            AND event.event_type = 'stage_transitioned_to_voting') AS voting_events
       FROM town.civic_processes process
       WHERE process.signal_id = $1`,
      [signalId],
    );
    expect(state.rows).toEqual([
      {
        current_stage: 'voting',
        ballot_transitions: '1',
        ballot_events: '1',
        voting_transitions: '1',
        voting_events: '1',
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        currentStage: 'voting',
        stageLabelKey: 'civic_process.stage.voting',
        confirmationCount: 5,
        proposalCount: 5,
        deliberationParticipantCount: 5,
        voteCount: 0,
        nextStage: 'mandate',
        transitionRule: null,
        timeline: [
          { type: 'process_created' },
          { type: 'stage_transitioned_to_proposals' },
          { type: 'stage_transitioned_to_deliberation' },
          { type: 'stage_transitioned_to_ballot_preparation' },
          { type: 'stage_transitioned_to_voting' },
        ],
      },
    });

    await expect(
      pool.query(
        `INSERT INTO town.civic_deliberation_contributions
           (id, process_id, proposal_id, author_actor_id, intent, text, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'observation', 'Too late to matter here', now())`,
        [processId, proposalIds[0], actorIds[5]],
      ),
    ).rejects.toThrow(/civic deliberation stage is closed/);

    await Promise.all([
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [processId, proposalIds[0], actorIds[0]],
      ),
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [processId, proposalIds[0], actorIds[1]],
      ),
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [processId, proposalIds[1], actorIds[2]],
      ),
    ]);

    await expect(
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [processId, proposalIds[1], actorIds[0]],
      ),
    ).rejects.toThrow(/civic_votes_process_actor_unique/);

    await expect(
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [processId, proposalIds[0], actorIds[5]],
      ),
    ).resolves.toBeDefined();

    const votingResponse = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/voting`,
    });
    expect(votingResponse.statusCode).toBe(200);
    const votingBody = votingResponse.json<{
      data: {
        currentStage: string;
        canVote: boolean;
        hasVoted: boolean;
        myChoice: string | null;
        totalVotes: number;
        options: { proposalId: string; voteCount: number }[];
      };
    }>();
    expect(votingBody.data.currentStage).toBe('voting');
    expect(votingBody.data.canVote).toBe(false);
    expect(votingBody.data.hasVoted).toBe(false);
    expect(votingBody.data.myChoice).toBeNull();
    expect(votingBody.data.totalVotes).toBe(4);
    const tallyByProposal = new Map(
      votingBody.data.options.map((option) => [option.proposalId, option.voteCount]),
    );
    const firstProposalId = proposalIds[0];
    const secondProposalId = proposalIds[1];
    if (!firstProposalId || !secondProposalId) throw new Error('missing proposal ids');
    expect(tallyByProposal.get(firstProposalId)).toBe(3);
    expect(tallyByProposal.get(secondProposalId)).toBe(1);
    expect(votingResponse.body).not.toMatch(/accountId|actorId/);
  });

  it('closes voting lazily, records an honest mandate for a clear winner, and opens action in the same chain', async () => {
    const signalId = randomUUID();
    const actorIds = Array.from({ length: 6 }, () => randomUUID());

    await pool.query(
      `INSERT INTO town.signals
       SELECT (jsonb_populate_record(
         NULL::town.signals,
         to_jsonb(source) || jsonb_build_object(
           'id', $1::uuid,
           'slug', 'civic-process-mandate-winner-test',
           'position', 32004,
           'created_at', now(),
           'updated_at', now(),
           'published_at', now()
         )
       )).*
       FROM town.signals source
       ORDER BY position
       LIMIT 1`,
      [signalId],
    );

    for (const actorId of actorIds) {
      await pool.query(
        `INSERT INTO town.actors (
           id, kind, status, display_label, community_id, account_id,
           local_eligibility_verified_at, community_commitment_accepted_at,
           community_commitment_version, created_at, updated_at
         )
         SELECT
           $1::uuid, 'controlled_test', 'active', $1::text, community_id, NULL,
           NULL, NULL, NULL, now(), now()
         FROM town.signals
         WHERE id = $2`,
        [actorId, signalId],
      );
    }

    await Promise.all(
      actorIds.slice(0, 5).map((actorId) =>
        pool.query(
          `INSERT INTO town.signal_confirmations
             (id, signal_id, actor_id, confirmed_at, created_at)
           VALUES (gen_random_uuid(), $1, $2, now(), now())`,
          [signalId, actorId],
        ),
      ),
    );

    const processRow = await pool.query<{ id: string }>(
      'SELECT id FROM town.civic_processes WHERE signal_id = $1',
      [signalId],
    );
    const processId = processRow.rows[0]?.id;
    if (!processId) throw new Error('missing process id');

    await Promise.all(
      actorIds.slice(0, 5).map((actorId, index) =>
        pool.query(
          `INSERT INTO town.civic_proposals
             (id, process_id, author_actor_id, title, body, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
          [processId, actorId, `Mandate proposal ${String(index)}`, `Body ${String(index)}`],
        ),
      ),
    );

    const proposalRows = await pool.query<{ id: string }>(
      'SELECT id FROM town.civic_proposals WHERE process_id = $1 ORDER BY created_at, id',
      [processId],
    );
    const proposalIds = proposalRows.rows.map((row) => row.id);
    const firstProposalId = proposalIds[0];
    const secondProposalId = proposalIds[1];
    if (!firstProposalId || !secondProposalId) throw new Error('missing proposal ids');

    await Promise.all(
      actorIds.slice(0, 5).map((actorId, index) =>
        pool.query(
          `INSERT INTO town.civic_deliberation_contributions
             (id, process_id, proposal_id, author_actor_id, intent, text, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'observation', $4, now())`,
          [processId, proposalIds[index], actorId, `Mandate deliberation number ${String(index)}`],
        ),
      ),
    );

    const stageAfterDeliberation = await pool.query<{ current_stage: string }>(
      'SELECT current_stage FROM town.civic_processes WHERE id = $1',
      [processId],
    );
    expect(stageAfterDeliberation.rows[0]?.current_stage).toBe('voting');

    await Promise.all([
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [processId, firstProposalId, actorIds[0]],
      ),
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [processId, firstProposalId, actorIds[1]],
      ),
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [processId, firstProposalId, actorIds[2]],
      ),
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [processId, secondProposalId, actorIds[3]],
      ),
    ]);

    await pool.query(
      "UPDATE town.civic_processes SET voting_closes_at = now() - interval '1 second' WHERE id = $1",
      [processId],
    );

    const mandateResponse = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/mandate`,
    });
    expect(mandateResponse.statusCode).toBe(200);
    expect(mandateResponse.json()).toMatchObject({
      data: {
        processId,
        currentStage: 'action',
        decided: true,
        contested: false,
        winner: {
          proposalId: firstProposalId,
          voteCount: 3,
        },
        totalVotes: 4,
      },
    });
    const mandateBody = mandateResponse.json<{ data: { decidedAt: string | null } }>();
    expect(mandateBody.data.decidedAt).not.toBeNull();
    expect(mandateResponse.body).not.toMatch(/accountId|actorId/);

    const dbState = await pool.query<{
      current_stage: string;
      mandate_transitions: string;
      mandate_events: string;
      action_transitions: string;
      action_events: string;
      mandate_proposal_id: string | null;
      mandate_vote_count: number;
      mandate_total_votes: number;
    }>(
      `SELECT
         process.current_stage,
         (SELECT count(*)::text
          FROM town.civic_process_transitions transition
          WHERE transition.process_id = process.id
            AND transition.from_stage = 'voting'
            AND transition.to_stage = 'mandate'
            AND transition.reason_key = 'voting_window_closed') AS mandate_transitions,
         (SELECT count(*)::text
          FROM town.civic_process_events event
          WHERE event.process_id = process.id
            AND event.event_type = 'stage_transitioned_to_mandate') AS mandate_events,
         (SELECT count(*)::text
          FROM town.civic_process_transitions transition
          WHERE transition.process_id = process.id
            AND transition.from_stage = 'mandate'
            AND transition.to_stage = 'action'
            AND transition.reason_key = 'mandate_decided') AS action_transitions,
         (SELECT count(*)::text
          FROM town.civic_process_events event
          WHERE event.process_id = process.id
            AND event.event_type = 'stage_transitioned_to_action') AS action_events,
         mandate.proposal_id AS mandate_proposal_id,
         mandate.vote_count AS mandate_vote_count,
         mandate.total_votes AS mandate_total_votes
       FROM town.civic_processes process
       LEFT JOIN town.civic_mandates mandate ON mandate.process_id = process.id
       WHERE process.signal_id = $1`,
      [signalId],
    );
    expect(dbState.rows).toEqual([
      {
        current_stage: 'action',
        mandate_transitions: '1',
        mandate_events: '1',
        action_transitions: '1',
        action_events: '1',
        mandate_proposal_id: firstProposalId,
        mandate_vote_count: 3,
        mandate_total_votes: 4,
      },
    ]);

    await expect(
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [processId, firstProposalId, actorIds[5]],
      ),
    ).rejects.toThrow(/civic voting stage is closed/);

    const processResponse = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process`,
    });
    expect(processResponse.statusCode).toBe(200);
    expect(processResponse.json()).toMatchObject({
      data: {
        currentStage: 'action',
        stageLabelKey: 'civic_process.stage.action',
        nextStage: 'verification',
        closingAt: null,
        transitionRule: null,
        timeline: [
          { type: 'process_created' },
          { type: 'stage_transitioned_to_proposals' },
          { type: 'stage_transitioned_to_deliberation' },
          { type: 'stage_transitioned_to_ballot_preparation' },
          { type: 'stage_transitioned_to_voting' },
          { type: 'stage_transitioned_to_mandate' },
          { type: 'stage_transitioned_to_action' },
        ],
      },
    });

    const actionReadResponse = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/action`,
    });
    expect(actionReadResponse.statusCode).toBe(200);
    expect(actionReadResponse.json()).toMatchObject({
      data: {
        processId,
        currentStage: 'action',
        winner: { proposalId: firstProposalId, voteCount: 3 },
        canPost: false,
        updates: [],
      },
    });

    await pool.query(
      `INSERT INTO town.civic_action_updates (id, process_id, author_actor_id, text, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'First status update on the winning proposal', now())`,
      [processId, actorIds[0]],
    );

    const updateRow = await pool.query<{ id: string }>(
      'SELECT id FROM town.civic_action_updates WHERE process_id = $1',
      [processId],
    );
    expect(updateRow.rows).toHaveLength(1);

    const actionReadAfterUpdate = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/action`,
    });
    expect(actionReadAfterUpdate.statusCode).toBe(200);
    const actionBody = actionReadAfterUpdate.json<{
      data: { updates: { id: string; authorDisplayName: string; text: string }[] };
    }>();
    expect(actionBody.data.updates).toHaveLength(1);
    expect(actionBody.data.updates[0]).toMatchObject({
      text: 'First status update on the winning proposal',
    });
    expect(actionReadAfterUpdate.body).not.toMatch(/accountId|actorId/);
  });

  it('reports a perfect tie as contested with no winner and no invented tie-break', async () => {
    const signalId = randomUUID();
    const actorIds = Array.from({ length: 6 }, () => randomUUID());

    await pool.query(
      `INSERT INTO town.signals
       SELECT (jsonb_populate_record(
         NULL::town.signals,
         to_jsonb(source) || jsonb_build_object(
           'id', $1::uuid,
           'slug', 'civic-process-mandate-tie-test',
           'position', 32005,
           'created_at', now(),
           'updated_at', now(),
           'published_at', now()
         )
       )).*
       FROM town.signals source
       ORDER BY position
       LIMIT 1`,
      [signalId],
    );

    for (const actorId of actorIds) {
      await pool.query(
        `INSERT INTO town.actors (
           id, kind, status, display_label, community_id, account_id,
           local_eligibility_verified_at, community_commitment_accepted_at,
           community_commitment_version, created_at, updated_at
         )
         SELECT
           $1::uuid, 'controlled_test', 'active', $1::text, community_id, NULL,
           NULL, NULL, NULL, now(), now()
         FROM town.signals
         WHERE id = $2`,
        [actorId, signalId],
      );
    }

    await Promise.all(
      actorIds.slice(0, 5).map((actorId) =>
        pool.query(
          `INSERT INTO town.signal_confirmations
             (id, signal_id, actor_id, confirmed_at, created_at)
           VALUES (gen_random_uuid(), $1, $2, now(), now())`,
          [signalId, actorId],
        ),
      ),
    );

    const processRow = await pool.query<{ id: string }>(
      'SELECT id FROM town.civic_processes WHERE signal_id = $1',
      [signalId],
    );
    const processId = processRow.rows[0]?.id;
    if (!processId) throw new Error('missing process id');

    await Promise.all(
      actorIds.slice(0, 5).map((actorId, index) =>
        pool.query(
          `INSERT INTO town.civic_proposals
             (id, process_id, author_actor_id, title, body, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
          [processId, actorId, `Tie proposal ${String(index)}`, `Body ${String(index)}`],
        ),
      ),
    );

    const proposalRows = await pool.query<{ id: string }>(
      'SELECT id FROM town.civic_proposals WHERE process_id = $1 ORDER BY created_at, id',
      [processId],
    );
    const proposalIds = proposalRows.rows.map((row) => row.id);
    const firstProposalId = proposalIds[0];
    const secondProposalId = proposalIds[1];
    if (!firstProposalId || !secondProposalId) throw new Error('missing proposal ids');

    await Promise.all(
      actorIds.slice(0, 5).map((actorId, index) =>
        pool.query(
          `INSERT INTO town.civic_deliberation_contributions
             (id, process_id, proposal_id, author_actor_id, intent, text, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'observation', $4, now())`,
          [processId, proposalIds[index], actorId, `Tie deliberation number ${String(index)}`],
        ),
      ),
    );

    await Promise.all([
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [processId, firstProposalId, actorIds[0]],
      ),
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, actor_id, cast_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [processId, secondProposalId, actorIds[1]],
      ),
    ]);

    await pool.query(
      "UPDATE town.civic_processes SET voting_closes_at = now() - interval '1 second' WHERE id = $1",
      [processId],
    );

    const mandateResponse = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/mandate`,
    });
    expect(mandateResponse.statusCode).toBe(200);
    expect(mandateResponse.json()).toMatchObject({
      data: {
        currentStage: 'mandate',
        decided: true,
        contested: true,
        winner: null,
        totalVotes: 2,
      },
    });

    const mandateRow = await pool.query<{ proposal_id: string | null }>(
      'SELECT proposal_id FROM town.civic_mandates WHERE process_id = $1',
      [processId],
    );
    expect(mandateRow.rows).toEqual([{ proposal_id: null }]);

    const stageState = await pool.query<{ current_stage: string; action_transitions: string }>(
      `SELECT
         process.current_stage,
         (SELECT count(*)::text
          FROM town.civic_process_transitions transition
          WHERE transition.process_id = process.id
            AND transition.from_stage = 'mandate'
            AND transition.to_stage = 'action') AS action_transitions
       FROM town.civic_processes process
       WHERE process.id = $1`,
      [processId],
    );
    expect(stageState.rows).toEqual([{ current_stage: 'mandate', action_transitions: '0' }]);

    const actionResponse = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/action`,
    });
    expect(actionResponse.statusCode).toBe(200);
    expect(actionResponse.json()).toMatchObject({
      data: { currentStage: 'mandate', winner: null, canPost: false, updates: [] },
    });

    await expect(
      pool.query(
        `INSERT INTO town.civic_action_updates (id, process_id, author_actor_id, text, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'A contested mandate never opens action', now())`,
        [processId, actorIds[0]],
      ),
    ).rejects.toThrow(/civic action stage is closed/);
  });

  it('marks a decided action ready, then archives as delivered once 5 actors confirm', async () => {
    const { signalId, processId, actorIds } = await buildDecidedProcessThroughAction(pool, app, {
      slug: 'civic-process-verification-delivered-test',
      position: 32006,
    });

    await simulateActionMarkedReady(pool, processId);

    await pool.query(
      `INSERT INTO town.civic_verification_evidence (id, process_id, author_actor_id, text, url, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'Delivered on site, photos attached', 'https://example.org/proof', now())`,
      [processId, actorIds[0]],
    );

    for (const actorId of actorIds.slice(0, 5)) {
      await pool.query(
        `INSERT INTO town.civic_verification_confirmations (id, process_id, actor_id, outcome, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'delivered', now())`,
        [processId, actorId],
      );
    }

    const dbState = await pool.query<{
      current_stage: string;
      outcome: string;
      delivered_count: number;
      not_delivered_count: number;
      archived_transitions: string;
      archived_events: string;
    }>(
      `SELECT
         process.current_stage,
         verification.outcome,
         verification.delivered_count,
         verification.not_delivered_count,
         (SELECT count(*)::text
          FROM town.civic_process_transitions transition
          WHERE transition.process_id = process.id
            AND transition.from_stage = 'verification'
            AND transition.to_stage = 'archived'
            AND transition.reason_key = 'verification_delivered_threshold_reached') AS archived_transitions,
         (SELECT count(*)::text
          FROM town.civic_process_events event
          WHERE event.process_id = process.id
            AND event.event_type = 'stage_transitioned_to_archived') AS archived_events
       FROM town.civic_processes process
       LEFT JOIN town.civic_verifications verification ON verification.process_id = process.id
       WHERE process.id = $1`,
      [processId],
    );
    expect(dbState.rows).toEqual([
      {
        current_stage: 'archived',
        outcome: 'delivered',
        delivered_count: 5,
        not_delivered_count: 0,
        archived_transitions: '1',
        archived_events: '1',
      },
    ]);

    const verificationResponse = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/verification`,
    });
    expect(verificationResponse.statusCode).toBe(200);
    expect(verificationResponse.json()).toMatchObject({
      data: {
        processId,
        currentStage: 'archived',
        canMarkReady: false,
        canConfirm: false,
        outcome: 'delivered',
        deliveredCount: 5,
        notDeliveredCount: 0,
      },
    });
    const verificationBody = verificationResponse.json<{
      data: { decidedAt: string | null; evidence: { text: string; url: string | null }[] };
    }>();
    expect(verificationBody.data.decidedAt).not.toBeNull();
    expect(verificationBody.data.evidence).toHaveLength(1);
    expect(verificationBody.data.evidence[0]).toMatchObject({
      text: 'Delivered on site, photos attached',
      url: 'https://example.org/proof',
    });
    expect(verificationResponse.body).not.toMatch(/accountId|actorId/);

    const processResponse = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process`,
    });
    expect(processResponse.statusCode).toBe(200);
    expect(processResponse.json()).toMatchObject({
      data: {
        currentStage: 'archived',
        stageLabelKey: 'civic_process.stage.archived',
        nextStage: null,
      },
    });
    const processBody = processResponse.json<{ data: { timeline: { type: string }[] } }>();
    expect(processBody.data.timeline.map((event) => event.type)).toContain(
      'stage_transitioned_to_archived',
    );

    await expect(
      pool.query(
        `INSERT INTO town.civic_verification_confirmations (id, process_id, actor_id, outcome, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'delivered', now())`,
        [processId, actorIds[5]],
      ),
    ).rejects.toThrow(/civic verification stage is closed/);
  });

  it('archives as not_delivered once 5 actors confirm the action was not delivered', async () => {
    const { signalId, processId, actorIds } = await buildDecidedProcessThroughAction(pool, app, {
      slug: 'civic-process-verification-not-delivered-test',
      position: 32007,
    });

    await simulateActionMarkedReady(pool, processId);

    for (const actorId of actorIds.slice(0, 5)) {
      await pool.query(
        `INSERT INTO town.civic_verification_confirmations (id, process_id, actor_id, outcome, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'not_delivered', now())`,
        [processId, actorId],
      );
    }

    const dbState = await pool.query<{ current_stage: string; outcome: string }>(
      `SELECT process.current_stage, verification.outcome
       FROM town.civic_processes process
       LEFT JOIN town.civic_verifications verification ON verification.process_id = process.id
       WHERE process.id = $1`,
      [processId],
    );
    expect(dbState.rows).toEqual([{ current_stage: 'archived', outcome: 'not_delivered' }]);

    const verificationResponse = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/verification`,
    });
    expect(verificationResponse.statusCode).toBe(200);
    expect(verificationResponse.json()).toMatchObject({
      data: {
        processId,
        currentStage: 'archived',
        outcome: 'not_delivered',
        deliveredCount: 0,
        notDeliveredCount: 5,
      },
    });
  });

  it('reports a live tally with no invented resolution while neither outcome reaches the threshold', async () => {
    const { signalId, processId, actorIds } = await buildDecidedProcessThroughAction(pool, app, {
      slug: 'civic-process-verification-dispute-test',
      position: 32008,
    });

    await simulateActionMarkedReady(pool, processId);

    await Promise.all([
      pool.query(
        `INSERT INTO town.civic_verification_confirmations (id, process_id, actor_id, outcome, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'delivered', now())`,
        [processId, actorIds[0]],
      ),
      pool.query(
        `INSERT INTO town.civic_verification_confirmations (id, process_id, actor_id, outcome, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'delivered', now())`,
        [processId, actorIds[1]],
      ),
      pool.query(
        `INSERT INTO town.civic_verification_confirmations (id, process_id, actor_id, outcome, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'delivered', now())`,
        [processId, actorIds[2]],
      ),
      pool.query(
        `INSERT INTO town.civic_verification_confirmations (id, process_id, actor_id, outcome, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'not_delivered', now())`,
        [processId, actorIds[3]],
      ),
      pool.query(
        `INSERT INTO town.civic_verification_confirmations (id, process_id, actor_id, outcome, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'not_delivered', now())`,
        [processId, actorIds[4]],
      ),
    ]);

    const dbState = await pool.query<{ current_stage: string }>(
      'SELECT current_stage FROM town.civic_processes WHERE id = $1',
      [processId],
    );
    expect(dbState.rows).toEqual([{ current_stage: 'verification' }]);

    const verificationRow = await pool.query<{ process_id: string }>(
      'SELECT process_id FROM town.civic_verifications WHERE process_id = $1',
      [processId],
    );
    expect(verificationRow.rows).toEqual([]);

    const verificationResponse = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/verification`,
    });
    expect(verificationResponse.statusCode).toBe(200);
    expect(verificationResponse.json()).toMatchObject({
      data: {
        processId,
        currentStage: 'verification',
        canMarkReady: false,
        outcome: null,
        decidedAt: null,
        deliveredCount: 3,
        notDeliveredCount: 2,
      },
    });

    const processResponse = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process`,
    });
    expect(processResponse.statusCode).toBe(200);
    expect(processResponse.json()).toMatchObject({
      data: {
        currentStage: 'verification',
        stageLabelKey: 'civic_process.stage.verification',
        nextStage: 'archived',
      },
    });
  });

  it('preserves fail-closed missing and invalid signal behavior', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/signals/00000000-0000-4000-8000-000000000999/civic-process',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: 'SIGNAL_NOT_FOUND' },
    });

    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/signals/not-a-uuid/civic-process',
    });
    expect(invalid.statusCode).toBe(400);
  });
});
