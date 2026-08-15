import type { FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';
import {
  arenaAccounts,
  arenaSignalIds,
  capacityDrillCycleFromEnv,
  mainAccountsA,
  mainSignalIdsA,
} from './fixtures.js';
import { collectCapacityVerifyResult } from '../run-capacity-verify.js';

const SAMPLE_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

type PreflightMode = 'real' | 'synthetic';

type PreflightFixture = {
  mode: PreflightMode;
  mainActorId: string;
  mainSignalId: string;
  arenaActorId: string;
  arenaSignalId: string;
  proposalTitle: string;
};

type DatabaseSampleRow = {
  current_connections: string;
  idle_in_transaction: string;
  lock_wait_pids: number[] | null;
  max_connections: string;
};

export type CapacityDatabaseMonitorSummary = {
  enabled: true;
  startedAt: string;
  lastSampleAt: string | null;
  samples: number;
  failedSamples: number;
  skippedSamples: number;
  maxConnections: number;
  maxConnectionPercent: number;
  maxIdleInTransaction: number;
  maxLockWaiters: number;
  maxObservedLockWaitMs: number;
  maxSampleGapMs: number;
};

function isCapacityMonitorEnabled(): boolean {
  return (
    process.env.RAILWAY_ENVIRONMENT_NAME === 'capacity' &&
    process.env.CAPACITY_DRILL_DB_MONITOR_ENABLED === 'true'
  );
}

const capacityDatabaseMonitorPlugin: FastifyPluginCallback = (app, _options, done) => {
  if (!isCapacityMonitorEnabled()) {
    done();
    return;
  }

  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let lastSampleAtMs: number | undefined;
  let lastHeartbeatAtMs = 0;
  let lastIntegrityAtMs = 0;
  const lockFirstObservedAt = new Map<number, number>();
  const summary: CapacityDatabaseMonitorSummary = {
    enabled: true,
    startedAt: new Date().toISOString(),
    lastSampleAt: null,
    samples: 0,
    failedSamples: 0,
    skippedSamples: 0,
    maxConnections: 0,
    maxConnectionPercent: 0,
    maxIdleInTransaction: 0,
    maxLockWaiters: 0,
    maxObservedLockWaitMs: 0,
    maxSampleGapMs: 0,
  };
  const cycle = capacityDrillCycleFromEnv();
  const mainAccounts = mainAccountsA(cycle);
  const mainSignals = mainSignalIdsA(cycle);
  const votingAccounts = arenaAccounts(cycle);
  const votingSignals = arenaSignalIds(cycle);
  const preflightFixtures: PreflightFixture[] = [
    {
      mode: 'real',
      mainActorId: mainAccounts[4]?.actorId ?? '',
      mainSignalId: mainSignals[0] ?? '',
      arenaActorId: votingAccounts[5]?.actorId ?? '',
      arenaSignalId: votingSignals[0] ?? '',
      proposalTitle: 'Capacity drill preflight proposal',
    },
    {
      mode: 'synthetic',
      mainActorId: mainAccounts[5]?.actorId ?? '',
      mainSignalId: mainSignals[1] ?? '',
      arenaActorId: votingAccounts[6]?.actorId ?? '',
      arenaSignalId: votingSignals[1] ?? '',
      proposalTitle: 'Capacity drill synthetic preflight proposal',
    },
  ];
  if (
    preflightFixtures.some(
      (fixture) =>
        !fixture.mainActorId ||
        !fixture.mainSignalId ||
        !fixture.arenaActorId ||
        !fixture.arenaSignalId,
    )
  ) {
    done(new Error('Capacity preflight monitor fixtures are incomplete'));
    return;
  }
  const emittedPreflightModes = new Set<PreflightMode>();

  const logSummary = (event: 'capacity_db_monitor_heartbeat' | 'capacity_db_monitor_summary') => {
    process.stdout.write(`${JSON.stringify({ event, capacityDbMonitor: { ...summary } })}\n`);
  };

  const verifyPreflightWrites = async (): Promise<void> => {
    for (const fixture of preflightFixtures) {
      if (emittedPreflightModes.has(fixture.mode)) continue;
      const [confirmation, proposal, vote] = await Promise.all([
        app.database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM town.signal_confirmations
           WHERE signal_id = $1 AND actor_id = $2`,
          [fixture.mainSignalId, fixture.mainActorId],
        ),
        app.database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM town.civic_proposals p
           JOIN town.civic_processes pr ON pr.id = p.process_id
           WHERE pr.signal_id = $1 AND p.author_actor_id = $2 AND p.title = $3`,
          [fixture.mainSignalId, fixture.mainActorId, fixture.proposalTitle],
        ),
        app.database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM town.civic_ballot_tokens t
           JOIN town.civic_processes pr ON pr.id = t.process_id
           WHERE pr.signal_id = $1 AND t.actor_id = $2 AND t.consumed_at IS NOT NULL`,
          [fixture.arenaSignalId, fixture.arenaActorId],
        ),
      ]);
      const counts = {
        confirmation: Number(confirmation.rows[0]?.count ?? 0),
        proposal: Number(proposal.rows[0]?.count ?? 0),
        vote: Number(vote.rows[0]?.count ?? 0),
      };
      if (Object.values(counts).some((count) => count > 1)) {
        emittedPreflightModes.add(fixture.mode);
        process.stdout.write(
          `${JSON.stringify({
            event: 'capacity_preflight_verify',
            capacityPreflightVerify: {
              outcome: 'failed',
              cycle,
              mode: fixture.mode,
              counts,
            },
          })}\n`,
        );
        continue;
      }
      if (Object.values(counts).every((count) => count === 1)) {
        emittedPreflightModes.add(fixture.mode);
        process.stdout.write(
          `${JSON.stringify({
            event: 'capacity_preflight_verify',
            capacityPreflightVerify: {
              outcome: 'passed',
              cycle,
              mode: fixture.mode,
              counts,
            },
          })}\n`,
        );
      }
    }
  };

  const sample = async (): Promise<void> => {
    if (inFlight) {
      summary.skippedSamples += 1;
      return;
    }

    inFlight = (async () => {
      const sampledAtMs = Date.now();
      if (lastSampleAtMs !== undefined) {
        summary.maxSampleGapMs = Math.max(summary.maxSampleGapMs, sampledAtMs - lastSampleAtMs);
      }
      lastSampleAtMs = sampledAtMs;
      summary.lastSampleAt = new Date(sampledAtMs).toISOString();

      try {
        const { rows } = await app.database.pool.query<DatabaseSampleRow>(
          `SELECT
             current_setting('max_connections') AS max_connections,
             count(*) FILTER (WHERE datname = current_database())::text AS current_connections,
             count(*) FILTER (
               WHERE datname = current_database() AND state = 'idle in transaction'
             )::text AS idle_in_transaction,
             COALESCE(
               array_agg(pid) FILTER (
                 WHERE datname = current_database() AND wait_event_type = 'Lock'
               ),
               ARRAY[]::integer[]
             ) AS lock_wait_pids
           FROM pg_stat_activity`,
        );
        const row = rows[0];
        if (!row) throw new Error('capacity database monitor returned no row');

        const currentConnections = Number(row.current_connections);
        const maxConnections = Number(row.max_connections);
        const idleInTransaction = Number(row.idle_in_transaction);
        const lockWaitPids = row.lock_wait_pids ?? [];
        if (
          !Number.isFinite(currentConnections) ||
          !Number.isFinite(maxConnections) ||
          maxConnections <= 0 ||
          !Number.isFinite(idleInTransaction)
        ) {
          throw new Error('capacity database monitor received invalid aggregate values');
        }

        const waitingNow = new Set(lockWaitPids);
        for (const pid of waitingNow) {
          const firstObservedAt = lockFirstObservedAt.get(pid) ?? sampledAtMs;
          lockFirstObservedAt.set(pid, firstObservedAt);
          summary.maxObservedLockWaitMs = Math.max(
            summary.maxObservedLockWaitMs,
            sampledAtMs - firstObservedAt,
          );
        }
        for (const pid of lockFirstObservedAt.keys()) {
          if (!waitingNow.has(pid)) lockFirstObservedAt.delete(pid);
        }

        summary.samples += 1;
        summary.maxConnections = Math.max(summary.maxConnections, currentConnections);
        summary.maxConnectionPercent = Math.max(
          summary.maxConnectionPercent,
          (currentConnections / maxConnections) * 100,
        );
        summary.maxIdleInTransaction = Math.max(summary.maxIdleInTransaction, idleInTransaction);
        summary.maxLockWaiters = Math.max(summary.maxLockWaiters, waitingNow.size);
        await verifyPreflightWrites();

        if (sampledAtMs - lastHeartbeatAtMs >= HEARTBEAT_INTERVAL_MS) {
          lastHeartbeatAtMs = sampledAtMs;
          logSummary('capacity_db_monitor_heartbeat');
        }
        if (sampledAtMs - lastIntegrityAtMs >= HEARTBEAT_INTERVAL_MS) {
          lastIntegrityAtMs = sampledAtMs;
          const capacityVerifyResult = await collectCapacityVerifyResult(app.database.pool, cycle);
          process.stdout.write(
            `${JSON.stringify({
              event: 'capacity_verify',
              capacityVerifyResult,
            })}\n`,
          );
        }
      } catch (error: unknown) {
        summary.failedSamples += 1;
        app.log.warn(
          {
            event: 'capacity_db_monitor_sample_failed',
            errorType: error instanceof Error ? error.name : 'UnknownError',
          },
          'capacity database monitor sample failed',
        );
      }
    })().finally(() => {
      inFlight = undefined;
    });

    await inFlight;
  };

  app.addHook('onReady', async () => {
    await sample();
    timer = setInterval(() => void sample(), SAMPLE_INTERVAL_MS);
    timer.unref();
  });

  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await inFlight;
    logSummary('capacity_db_monitor_summary');
  });

  done();
};

export const capacityDatabaseMonitor = fp(capacityDatabaseMonitorPlugin, {
  name: 'capacity-database-monitor',
  dependencies: ['database'],
});
