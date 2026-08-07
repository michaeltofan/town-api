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
       ON CONFLICT (process_id, from_stage, to_stage, ballot_cycle) DO NOTHING`,
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
       ON CONFLICT (process_id, event_type, ballot_cycle) DO NOTHING`,
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

// The 10-minute ballot-preparation freeze window (§8) is only ever closed
// lazily, as a side effect of a route touching the process, not from raw
// SQL — rewind voting_opens_at into the past, then trigger it via the same
// public read every real caller would use, exactly like the analogous
// voting-close pattern below.
async function advanceBallotPreparationToVoting(
  pool: Pool,
  app: Awaited<ReturnType<typeof createSeededTestApp>>['app'],
  input: { signalId: string; processId: string },
): Promise<void> {
  await pool.query(
    "UPDATE town.civic_processes SET voting_opens_at = now() - interval '1 second' WHERE id = $1",
    [input.processId],
  );
  const response = await app.inject({
    method: 'GET',
    url: `/v1/signals/${input.signalId}/civic-process`,
  });
  if (response.statusCode !== 200) {
    throw new Error('failed to lazily open voting while building fixture');
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
  const thirdProposalId = proposalIds[2];
  if (!winningProposalId || !secondProposalId || !thirdProposalId) {
    throw new Error('missing proposal ids');
  }

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

  await advanceBallotPreparationToVoting(pool, app, { signalId, processId });

  await Promise.all([
    pool.query(
      `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
       VALUES (gen_random_uuid(), $1, $2, 1, now())`,
      [processId, winningProposalId],
    ),
    pool.query(
      `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
       VALUES (gen_random_uuid(), $1, $2, 1, now())`,
      [processId, winningProposalId],
    ),
    pool.query(
      `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
       VALUES (gen_random_uuid(), $1, $2, 1, now())`,
      [processId, winningProposalId],
    ),
    pool.query(
      `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
       VALUES (gen_random_uuid(), $1, $2, 1, now())`,
      [processId, secondProposalId],
    ),
    // A fifth vote for a fourth proposal — needed to clear quorum (§9: at
    // least 5 votes) without changing the winning proposal's vote count.
    pool.query(
      `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
       VALUES (gen_random_uuid(), $1, $2, 1, now())`,
      [processId, thirdProposalId],
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

  it('self-heals a published signal whose civic process was never provisioned', async () => {
    // Reproduces a real production gap: signals upserted via
    // ON CONFLICT DO UPDATE (e.g. re-seeding foundation content against rows
    // that already exist) do not re-fire the AFTER INSERT trigger, so some
    // published signals ended up with no matching civic_processes row and the
    // read endpoint threw a 500. Simulate that gap directly by disabling the
    // trigger for one insert, then confirm the read endpoint backfills the
    // missing process instead of failing.
    const signalId = randomUUID();
    await pool.query('ALTER TABLE town.signals DISABLE TRIGGER signals_provision_civic_process');
    try {
      await pool.query(
        `INSERT INTO town.signals
         SELECT (jsonb_populate_record(
           NULL::town.signals,
           to_jsonb(source) || jsonb_build_object(
             'id', $1::uuid,
             'slug', 'civic-process-missing-trigger-test',
             'position', 32009,
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
    } finally {
      await pool.query('ALTER TABLE town.signals ENABLE TRIGGER signals_provision_civic_process');
    }

    const beforeHeal = await pool.query(
      'SELECT id FROM town.civic_processes WHERE signal_id = $1',
      [signalId],
    );
    expect(beforeHeal.rows).toHaveLength(0);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: { id: string } }>();
    expect(response.json()).toMatchObject({
      data: {
        signalId,
        currentStage: 'confirmation',
        nextStage: 'proposals',
        confirmationCount: 0,
      },
    });

    const healed = await pool.query<{
      id: string;
      event_type: string;
      event_count: string;
    }>(
      `SELECT p.id, min(e.event_type) AS event_type, count(e.id)::text AS event_count
       FROM town.civic_processes p
       JOIN town.civic_process_events e ON e.process_id = p.id
       WHERE p.signal_id = $1
       GROUP BY p.id`,
      [signalId],
    );
    expect(healed.rows).toEqual([
      { id: body.data.id, event_type: 'process_created', event_count: '1' },
    ]);

    // A second read must not crash or duplicate the ledger — the process
    // already exists now, so this exercises the ordinary (non-healing) path.
    const secondResponse = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process`,
    });
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json<{ data: { id: string } }>().data.id).toBe(body.data.id);
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

  it('advances into ballot_preparation, freezes proposals, snapshots eligible voters, previews the ballot, then opens voting once the freeze window elapses', async () => {
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
        current_stage: 'ballot_preparation',
        ballot_transitions: '1',
        ballot_events: '1',
        voting_transitions: '0',
        voting_events: '0',
      },
    ]);

    // Every non-withdrawn proposal is frozen the instant ballot_preparation
    // begins — the frozen set becomes the fixed ballot (§8).
    const frozenProposals = await pool.query<{
      lifecycle_state: string;
      frozen_at: string | null;
    }>('SELECT lifecycle_state, frozen_at FROM town.civic_proposals WHERE process_id = $1', [
      processId,
    ]);
    expect(frozenProposals.rows).toHaveLength(5);
    for (const row of frozenProposals.rows) {
      expect(row.lifecycle_state).toBe('frozen');
      expect(row.frozen_at).not.toBeNull();
    }

    // The eligible-voter snapshot includes every active actor in the
    // community at freeze time — a superset of this test's own actors
    // (shared foundation community, other tests' actors included), and
    // crucially still includes actorIds[5], who never confirmed, proposed,
    // or deliberated on this specific signal.
    const eligibleActors = await pool.query<{ actor_id: string }>(
      'SELECT actor_id FROM town.civic_ballot_eligible_actors WHERE process_id = $1',
      [processId],
    );
    const eligibleActorIds = eligibleActors.rows.map((row) => row.actor_id);
    for (const actorId of actorIds) {
      expect(eligibleActorIds).toContain(actorId);
    }

    const ballotPreparationResponse = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process`,
    });
    expect(ballotPreparationResponse.statusCode).toBe(200);
    const ballotPreparationBody = ballotPreparationResponse.json<{
      data: {
        ballotPreview: {
          question: string;
          proposals: { id: string }[];
          votingOpensAt: string;
          votingClosesAt: string;
          ballotType: string;
          quorum: number;
          eligibleVoterCount: number;
          winRuleKey: string;
        } | null;
      };
    }>();
    expect(ballotPreparationResponse.json()).toMatchObject({
      data: {
        currentStage: 'ballot_preparation',
        stageLabelKey: 'civic_process.stage.ballot_preparation',
        nextStage: 'voting',
        transitionRule: null,
        timeline: [
          { type: 'process_created' },
          { type: 'stage_transitioned_to_proposals' },
          { type: 'stage_transitioned_to_deliberation' },
          { type: 'stage_transitioned_to_ballot_preparation' },
        ],
      },
    });
    const ballotPreview = ballotPreparationBody.data.ballotPreview;
    expect(ballotPreview).not.toBeNull();
    if (!ballotPreview) throw new Error('expected a ballot preview');
    expect(ballotPreview.question).toBe("Which proposal should this signal's mandate be?");
    expect(new Set(ballotPreview.proposals.map((proposal) => proposal.id))).toEqual(
      new Set(proposalIds),
    );
    expect(ballotPreview.ballotType).toBe('approval');
    expect(ballotPreview.quorum).toBe(5);
    expect(ballotPreview.eligibleVoterCount).toBe(eligibleActorIds.length);
    expect(ballotPreview.winRuleKey).toBe('most_approvals_no_tiebreak');
    const votingOpensAtMs = new Date(ballotPreview.votingOpensAt).getTime();
    const votingClosesAtMs = new Date(ballotPreview.votingClosesAt).getTime();
    expect(votingClosesAtMs - votingOpensAtMs).toBe(72 * 60 * 60 * 1000);

    // Voting is not open yet: a vote cast during ballot_preparation is
    // rejected, and the ballot cannot be reached through the voting route.
    await expect(
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, proposalIds[0]],
      ),
    ).rejects.toThrow(/civic voting stage is closed/);

    await advanceBallotPreparationToVoting(pool, app, { signalId, processId });

    const stateAfterFreezeWindow = await pool.query<{
      current_stage: string;
      voting_transitions: string;
      voting_events: string;
    }>(
      `SELECT
         process.current_stage,
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
    expect(stateAfterFreezeWindow.rows).toEqual([
      { current_stage: 'voting', voting_transitions: '1', voting_events: '1' },
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
        ballotPreview: null,
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
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, proposalIds[0]],
      ),
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, proposalIds[0]],
      ),
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, proposalIds[1]],
      ),
    ]);

    // One-vote-per-actor is no longer a civic_votes constraint (the vote row
    // carries no actor link at all, §9) — it is enforced entirely by
    // single-use ballot token consumption at the application layer
    // (see civic-voting.integration.test.ts for that coverage). A fourth
    // anonymous vote arriving at the DB layer is simply another vote.
    await expect(
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, proposalIds[0]],
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
        totalVotes: number;
        options: { proposalId: string; voteCount: number }[];
      };
    }>();
    expect(votingBody.data.currentStage).toBe('voting');
    expect(votingBody.data.canVote).toBe(false);
    expect(votingBody.data.hasVoted).toBe(false);
    expect(votingBody.data).not.toHaveProperty('myChoice');
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
    const thirdProposalId = proposalIds[2];
    if (!firstProposalId || !secondProposalId || !thirdProposalId) {
      throw new Error('missing proposal ids');
    }

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
    expect(stageAfterDeliberation.rows[0]?.current_stage).toBe('ballot_preparation');

    await advanceBallotPreparationToVoting(pool, app, { signalId, processId });

    await Promise.all([
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, firstProposalId],
      ),
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, firstProposalId],
      ),
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, firstProposalId],
      ),
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, secondProposalId],
      ),
      // A fifth vote for a third, non-winning proposal — needed to clear
      // quorum (§9: at least 5 votes) without changing the 3-vs-1 clear-
      // winner shape this test is about.
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, thirdProposalId],
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
        totalVotes: 5,
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
        mandate_total_votes: 5,
      },
    ]);

    await expect(
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, firstProposalId],
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
    const thirdProposalId = proposalIds[2];
    if (!firstProposalId || !secondProposalId || !thirdProposalId) {
      throw new Error('missing proposal ids');
    }

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

    await advanceBallotPreparationToVoting(pool, app, { signalId, processId });

    // Two votes each for the tied top proposals, plus one for a third
    // (untied) proposal — needed to clear quorum (§9: at least 5 votes)
    // without disturbing the perfect-tie-at-top shape this test is about.
    await Promise.all([
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, firstProposalId],
      ),
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, firstProposalId],
      ),
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, secondProposalId],
      ),
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, secondProposalId],
      ),
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, thirdProposalId],
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
        totalVotes: 5,
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

  it('returns to deliberation on quorum failure, then decides a real mandate on the retry cycle', async () => {
    const signalId = randomUUID();
    const actorIds = Array.from({ length: 7 }, () => randomUUID());

    await pool.query(
      `INSERT INTO town.signals
       SELECT (jsonb_populate_record(
         NULL::town.signals,
         to_jsonb(source) || jsonb_build_object(
           'id', $1::uuid,
           'slug', 'civic-process-quorum-retry-test',
           'position', 32010,
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
          [processId, actorId, `Quorum retry proposal ${String(index)}`, `Body ${String(index)}`],
        ),
      ),
    );

    const proposalRows = await pool.query<{ id: string }>(
      'SELECT id FROM town.civic_proposals WHERE process_id = $1 ORDER BY created_at, id',
      [processId],
    );
    const proposalIds = proposalRows.rows.map((row) => row.id);
    const firstProposalId = proposalIds[0];
    if (!firstProposalId) throw new Error('missing proposal ids');

    await Promise.all(
      actorIds.slice(0, 5).map((actorId, index) =>
        pool.query(
          `INSERT INTO town.civic_deliberation_contributions
             (id, process_id, proposal_id, author_actor_id, intent, text, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'observation', $4, now())`,
          [processId, proposalIds[index], actorId, `Quorum retry deliberation ${String(index)}`],
        ),
      ),
    );

    const stageAfterDeliberation = await pool.query<{
      current_stage: string;
      ballot_cycle: number;
    }>('SELECT current_stage, ballot_cycle FROM town.civic_processes WHERE id = $1', [processId]);
    expect(stageAfterDeliberation.rows[0]).toMatchObject({
      current_stage: 'ballot_preparation',
      ballot_cycle: 1,
    });

    const frozenAtCycle1 = await pool.query<{ frozen_at: string }>(
      'SELECT frozen_at FROM town.civic_proposals WHERE id = $1',
      [firstProposalId],
    );
    const originalFrozenAt = frozenAtCycle1.rows[0]?.frozen_at;
    expect(originalFrozenAt).toBeDefined();

    await advanceBallotPreparationToVoting(pool, app, { signalId, processId });

    // Only 2 of the 5 eligible actors vote — well under quorum (5).
    await Promise.all([
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, firstProposalId],
      ),
      pool.query(
        `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
         VALUES (gen_random_uuid(), $1, $2, 1, now())`,
        [processId, firstProposalId],
      ),
    ]);

    await pool.query(
      "UPDATE town.civic_processes SET voting_closes_at = now() - interval '1 second' WHERE id = $1",
      [processId],
    );

    const mandateAfterQuorumFailure = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/mandate`,
    });
    expect(mandateAfterQuorumFailure.statusCode).toBe(200);
    expect(mandateAfterQuorumFailure.json()).toMatchObject({
      data: {
        processId,
        currentStage: 'deliberation',
        decided: false,
        contested: false,
        quorumFailed: true,
        winner: null,
        totalVotes: 2,
      },
    });

    const stateAfterQuorumFailure = await pool.query<{
      current_stage: string;
      ballot_cycle: number;
      quorum_transitions: string;
      quorum_events: string;
      mandate_rows: string;
    }>(
      `SELECT
         process.current_stage,
         process.ballot_cycle,
         (SELECT count(*)::text
          FROM town.civic_process_transitions transition
          WHERE transition.process_id = process.id
            AND transition.from_stage = 'voting'
            AND transition.to_stage = 'deliberation'
            AND transition.reason_key = 'quorum_not_reached'
            AND transition.ballot_cycle = 1) AS quorum_transitions,
         (SELECT count(*)::text
          FROM town.civic_process_events event
          WHERE event.process_id = process.id
            AND event.event_type = 'stage_returned_to_deliberation_after_quorum_failure'
            AND event.ballot_cycle = 1) AS quorum_events,
         (SELECT count(*)::text FROM town.civic_mandates mandate
          WHERE mandate.process_id = process.id) AS mandate_rows
       FROM town.civic_processes process
       WHERE process.id = $1`,
      [processId],
    );
    expect(stateAfterQuorumFailure.rows).toEqual([
      {
        current_stage: 'deliberation',
        ballot_cycle: 2,
        quorum_transitions: '1',
        quorum_events: '1',
        mandate_rows: '0',
      },
    ]);

    // The frozen ballot content survives the failed cycle untouched.
    const frozenAfterQuorumFailure = await pool.query<{
      lifecycle_state: string;
      frozen_at: string;
    }>('SELECT lifecycle_state, frozen_at FROM town.civic_proposals WHERE id = $1', [
      firstProposalId,
    ]);
    expect(frozenAfterQuorumFailure.rows[0]?.lifecycle_state).toBe('frozen');
    expect(frozenAfterQuorumFailure.rows[0]?.frozen_at).toEqual(originalFrozenAt);

    // One more contribution re-triggers the deliberation threshold (the
    // cumulative distinct-participant count already cleared it) and starts
    // ballot cycle 2 — a new, explicitly audited cycle, not a silent retry.
    await pool.query(
      `INSERT INTO town.civic_deliberation_contributions
         (id, process_id, proposal_id, author_actor_id, intent, text, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'observation', 'One more contribution to retry the ballot', now())`,
      [processId, firstProposalId, actorIds[5]],
    );

    const stateAfterRetryBallotPreparation = await pool.query<{
      current_stage: string;
      ballot_cycle: number;
      transitions_cycle_2: string;
    }>(
      `SELECT
         process.current_stage,
         process.ballot_cycle,
         (SELECT count(*)::text
          FROM town.civic_process_transitions transition
          WHERE transition.process_id = process.id
            AND transition.from_stage = 'deliberation'
            AND transition.to_stage = 'ballot_preparation'
            AND transition.ballot_cycle = 2) AS transitions_cycle_2
       FROM town.civic_processes process
       WHERE process.id = $1`,
      [processId],
    );
    expect(stateAfterRetryBallotPreparation.rows).toEqual([
      { current_stage: 'ballot_preparation', ballot_cycle: 2, transitions_cycle_2: '1' },
    ]);

    // The eligible-voter snapshot for cycle 2 is a superset covering every
    // active actor in the shared foundation community (other tests' actors
    // included) — a re-snapshot, not a re-run of the original 7.
    const eligibleActorsCycle2 = await pool.query<{ actor_id: string }>(
      'SELECT actor_id FROM town.civic_ballot_eligible_actors WHERE process_id = $1 AND ballot_cycle = 2',
      [processId],
    );
    const eligibleActorIdsCycle2 = eligibleActorsCycle2.rows.map((row) => row.actor_id);
    for (const actorId of actorIds) {
      expect(eligibleActorIdsCycle2).toContain(actorId);
    }

    await advanceBallotPreparationToVoting(pool, app, { signalId, processId });

    const tokensCycle2 = await pool.query<{ actor_id: string }>(
      `SELECT actor_id FROM town.civic_ballot_tokens
       WHERE process_id = $1 AND ballot_cycle = 2`,
      [processId],
    );
    const tokenActorIdsCycle2 = tokensCycle2.rows.map((row) => row.actor_id);
    for (const actorId of actorIds) {
      expect(tokenActorIdsCycle2).toContain(actorId);
    }

    // This time, 5 of the 7 eligible actors vote — quorum is cleared.
    await Promise.all(
      actorIds.slice(0, 5).map((_actorId) =>
        pool.query(
          `INSERT INTO town.civic_votes (id, process_id, proposal_id, ballot_cycle, cast_at)
           VALUES (gen_random_uuid(), $1, $2, 2, now())`,
          [processId, firstProposalId],
        ),
      ),
    );

    await pool.query(
      "UPDATE town.civic_processes SET voting_closes_at = now() - interval '1 second' WHERE id = $1",
      [processId],
    );

    const mandateAfterRetry = await app.inject({
      method: 'GET',
      url: `/v1/signals/${signalId}/civic-process/mandate`,
    });
    expect(mandateAfterRetry.statusCode).toBe(200);
    expect(mandateAfterRetry.json()).toMatchObject({
      data: {
        processId,
        currentStage: 'action',
        decided: true,
        contested: false,
        quorumFailed: false,
        winner: { proposalId: firstProposalId, voteCount: 5 },
        totalVotes: 5,
      },
    });
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
