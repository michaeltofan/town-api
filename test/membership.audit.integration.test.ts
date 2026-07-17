import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { createDatabase, type Database } from '../src/db/client.js';
import { identitySecurityEvents } from '../src/db/schema.js';
import { createAccountShell } from '../src/identity/repositories/accounts.js';
import { activateMembership } from '../src/membership/transitions/activate.js';
import { expireMembership } from '../src/membership/transitions/expire.js';
import { reactivateMembership } from '../src/membership/transitions/reactivate.js';
import { scheduleMembershipCancellation } from '../src/membership/transitions/schedule-cancellation.js';
import { Pool } from 'pg';
import { requireDatabaseUrl, resetMigrateSeedFoundationAndActor } from './helpers/pg.js';

describe('membership audit events', () => {
  let pool: Pool;
  let database: Database;
  const accountId = '11000000-0000-4000-8000-000000000601';

  beforeAll(async () => {
    const url = requireDatabaseUrl();
    pool = new Pool({ connectionString: url, max: 1 });
    await resetMigrateSeedFoundationAndActor(pool);
    database = createDatabase({
      connectionString: url,
      poolMax: 3,
      connectionTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    await createAccountShell(database.db, {
      id: accountId,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it('records all required membership audit event types with bounded metadata', async () => {
    await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_audit_activate',
        eventType: 'activate',
        accountId,
        effectiveAt: '2026-07-17T12:00:00.000Z',
        accessUntil: '2026-09-17T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-17T12:00:00.000Z' },
    );
    // Replay same
    await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_audit_activate',
        eventType: 'activate',
        accountId,
        effectiveAt: '2026-07-17T12:00:00.000Z',
        accessUntil: '2026-09-17T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-17T13:00:00.000Z' },
    );
    // Divergent same-id
    await activateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_audit_activate',
        eventType: 'activate',
        accountId,
        effectiveAt: '2026-07-17T12:00:00.000Z',
        accessUntil: '2027-01-01T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-17T14:00:00.000Z' },
    );
    await scheduleMembershipCancellation(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_audit_cancel',
        eventType: 'schedule_cancellation',
        accountId,
        effectiveAt: '2026-07-18T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-18T00:00:00.000Z' },
    );
    await reactivateMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_audit_reactivate',
        eventType: 'reactivate',
        accountId,
        effectiveAt: '2026-07-19T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-07-19T00:00:00.000Z' },
    );
    await expireMembership(
      database.db,
      {
        source: 'test_fixture',
        sourceEventId: 'evt_audit_expire',
        eventType: 'expire',
        accountId,
        effectiveAt: '2026-09-17T00:00:00.000Z',
      },
      { nodeEnv: 'test', processedAt: '2026-09-17T00:00:00.000Z' },
    );

    const events = await database.db
      .select()
      .from(identitySecurityEvents)
      .where(
        and(
          eq(identitySecurityEvents.accountId, accountId),
          inArray(identitySecurityEvents.eventType, [
            'membership_created',
            'membership_activated',
            'membership_cancellation_scheduled',
            'membership_reactivated',
            'membership_expired',
            'membership_event_replayed',
            'membership_event_rejected',
          ]),
        ),
      );

    const types = new Set(events.map((e) => e.eventType));
    expect(types).toContain('membership_created');
    expect(types).toContain('membership_activated');
    expect(types).toContain('membership_cancellation_scheduled');
    expect(types).toContain('membership_reactivated');
    expect(types).toContain('membership_expired');
    expect(types).toContain('membership_event_replayed');
    expect(types).toContain('membership_event_rejected');

    // Metadata must be bounded scalars only, without any secrets or provider details.
    for (const event of events) {
      const metadata = event.metadata as Record<string, unknown> | null;
      expect(metadata).not.toBeNull();
      for (const [key, value] of Object.entries(metadata ?? {})) {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
        expect(key).not.toMatch(/email|password|token|cookie|authorization|ip|card/i);
      }
      const stringified = JSON.stringify(metadata);
      expect(stringified).not.toMatch(/cus_[A-Za-z0-9]+/);
      expect(stringified).not.toMatch(/sub_[A-Za-z0-9]+/);
    }
  });
});
