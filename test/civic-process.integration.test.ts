import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { FOUNDATION_SIGNAL_IDS } from '../src/db/seeds/foundation-content.js';
import { createSeededTestApp } from './helpers/pg.js';

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

    const invalid = await pool.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM town.civic_processes p
      JOIN town.signals s ON s.id = p.signal_id
      WHERE p.community_id <> s.community_id
         OR p.current_stage <> 'confirmation'`);
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
      { stage: 'confirmation', event_type: 'process_created', event_count: '1' },
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
        transitionRule: null,
        timeline: [{ type: 'process_created' }],
      },
    });
    expect(response.body).not.toMatch(/accountId|actorId|email|providerId|denialReason/);
  });

  it('preserves fail-closed missing and invalid signal behavior', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/signals/00000000-0000-4000-8000-000000000999/civic-process',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'SIGNAL_NOT_FOUND' } });

    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/signals/not-a-uuid/civic-process',
    });
    expect(invalid.statusCode).toBe(400);
  });
});
