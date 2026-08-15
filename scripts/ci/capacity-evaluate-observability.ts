#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';

type JsonObject = Record<string, unknown>;
type MetricSample = { timestamp: number; value: number };

const [apiMetricsPath, postgresMetricsPath, dbMonitorLogsPath, outputPath] = process.argv.slice(2);
if (!apiMetricsPath || !postgresMetricsPath || !dbMonitorLogsPath || !outputPath) {
  throw new Error(
    'usage: capacity-evaluate-observability.ts <api-metrics.json> <postgres-metrics.json> <db-monitor-logs.json> <output.json>',
  );
}

function object(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

// Verified against the exact `@railway/cli` build this workflow installs
// (`npm install -g @railway/cli`, currently 5.41.2) by reading its source
// (railwayapp/cli, src/commands/metrics.rs, print_raw_json()) rather than
// guessing from a live failure. That function builds the `--raw --json`
// payload as:
//   let mut measurements = serde_json::Map::new();
//   for metric in &res.metrics {
//       measurements.insert(metric.measurement.clone(), points_to_json(...));
//   }
//   json.insert("measurements", Object(measurements));
// So `measurements` is a JSON *object* keyed by measurement name (e.g.
// "CPU_USAGE", "CPU_LIMIT", "MEMORY_USAGE_GB", "MEMORY_LIMIT_GB"), each
// value a plain array of points -- not an array of `{measurement, samples}`
// wrapper objects as PR #152 assumed. `serde_json::Map` is a `BTreeMap` by
// default, which explains the alphabetical top-level key order seen in the
// real failure (environment, measurements, service, window) and why
// `Array.isArray(measurements)` was false: the real payload has an object
// there, not an array.
//
// Each point comes from points_to_json(), which always emits
// `{"ts": <RFC3339 string>, "value": <number>}` -- the field is `ts`, not
// `timestamp`, and it is always a string (chrono's `to_rfc3339()`), never a
// raw epoch number. parseTimestamp() still accepts an epoch number/numeric
// string defensively, but the real CLI output only ever produces the RFC3339
// string branch.
function parseTimestamp(value: unknown): number {
  if (typeof value === 'number') return value * 1000;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value) * 1000;
  return Date.parse(stringValue(value));
}

function metricSeries(document: unknown, name: string): MetricSample[] {
  const root = object(document);
  const measurements = object(root?.measurements) ?? {};
  const key = Object.keys(measurements).find((candidate) => candidate.toUpperCase().includes(name));
  const pointsCandidate = key ? measurements[key] : undefined;
  const points = Array.isArray(pointsCandidate) ? pointsCandidate : [];
  return points
    .map(object)
    .filter((point): point is JsonObject => point !== null)
    .map((point) => ({
      timestamp: parseTimestamp(point.ts ?? point.timestamp),
      value: Number(point.value),
    }))
    .filter((sample) => Number.isFinite(sample.value));
}

function nearestLimit(usageSample: MetricSample, limits: MetricSample[]): MetricSample {
  const timestamped = limits
    .filter(
      (sample) => Number.isFinite(sample.timestamp) && sample.timestamp <= usageSample.timestamp,
    )
    .at(-1);
  const limit = timestamped ?? limits.at(-1);
  if (!limit) throw new Error('resource limit series is empty');
  return limit;
}

function describeShape(document: unknown): string {
  const root = object(document);
  const measurements = object(root?.measurements);
  return JSON.stringify({
    topLevelKeys: root ? Object.keys(root) : typeof document,
    measurementsObjectFound: measurements !== null,
    measurementKeys: measurements ? Object.keys(measurements) : null,
    pointCounts: measurements
      ? Object.fromEntries(
          Object.entries(measurements).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.length : 'not-an-array',
          ]),
        )
      : null,
  });
}

function resourceSummary(document: unknown, service: 'api' | 'postgres') {
  const cpuUsage = metricSeries(document, 'CPU_USAGE');
  const cpuLimits = metricSeries(document, 'CPU_LIMIT').filter((sample) => sample.value > 0);
  const memoryUsage = metricSeries(document, 'MEMORY_USAGE');
  const memoryLimits = metricSeries(document, 'MEMORY_LIMIT').filter((sample) => sample.value > 0);
  if (!cpuUsage.length || !cpuLimits.length || !memoryUsage.length || !memoryLimits.length) {
    throw new Error(
      `${service}: missing CPU or memory usage/limit samples ` +
        `(cpuUsage=${String(cpuUsage.length)} cpuLimits=${String(cpuLimits.length)} ` +
        `memoryUsage=${String(memoryUsage.length)} memoryLimits=${String(memoryLimits.length)}) -- ` +
        `raw shape: ${describeShape(document)}`,
    );
  }

  const cpuPercent = cpuUsage.map(
    (sample) => (sample.value / nearestLimit(sample, cpuLimits).value) * 100,
  );
  const memoryPercent = memoryUsage.map(
    (sample) => (sample.value / nearestLimit(sample, memoryLimits).value) * 100,
  );
  const cpuAveragePercent = cpuPercent.reduce((sum, value) => sum + value, 0) / cpuPercent.length;
  const cpuPeakPercent = Math.max(...cpuPercent);
  const memoryPeakPercent = Math.max(...memoryPercent);

  return {
    service,
    cpuSamples: cpuPercent.length,
    memorySamples: memoryPercent.length,
    cpuAveragePercent,
    cpuPeakPercent,
    memoryPeakPercent,
    passed: cpuAveragePercent < 70 && cpuPeakPercent < 85 && memoryPeakPercent < 80,
  };
}

function parseMonitorRecord(value: unknown): JsonObject | null {
  if (typeof value !== 'string') return null;
  try {
    return object(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function requiredNumber(record: JsonObject, key: string): number {
  const value = Number(record[key]);
  if (!Number.isFinite(value)) throw new Error(`invalid capacityDbMonitor field: ${key}`);
  return value;
}

function databaseMonitorSummary(document: unknown) {
  const root = object(document);
  const data = object(root?.data);
  const logsCandidate = data?.deploymentLogs ?? root?.deploymentLogs;
  const logs = Array.isArray(logsCandidate) ? logsCandidate : [];
  const summaries: JsonObject[] = [];
  for (const logValue of logs) {
    const log = object(logValue);
    const attributes = Array.isArray(log?.attributes) ? log.attributes : [];
    for (const attributeValue of attributes) {
      const attribute = object(attributeValue);
      if (attribute?.key !== 'capacityDbMonitor') continue;
      const parsed = parseMonitorRecord(attribute.value);
      if (parsed) summaries.push(parsed);
    }
    if (typeof log?.message === 'string' && log.message.includes('capacityDbMonitor')) {
      const parsedMessage = parseMonitorRecord(log.message);
      const parsedSummary = object(parsedMessage?.capacityDbMonitor);
      if (parsedSummary) summaries.push(parsedSummary);
    }
  }
  const latest = summaries.at(-1);
  if (!latest) throw new Error('no capacityDbMonitor records found');

  const startedAtMs = Date.parse(stringValue(latest.startedAt));
  const lastSampleAtMs = Date.parse(stringValue(latest.lastSampleAt));
  const samples = requiredNumber(latest, 'samples');
  const failedSamples = requiredNumber(latest, 'failedSamples');
  const skippedSamples = requiredNumber(latest, 'skippedSamples');
  const maxSampleGapMs = requiredNumber(latest, 'maxSampleGapMs');
  const maxConnectionPercent = requiredNumber(latest, 'maxConnectionPercent');
  // Reported for visibility only, not gated on: this counts point-in-time
  // snapshots of pg_stat_activity with state = 'idle in transaction', which
  // catches ordinary short multi-statement transactions (db.transaction()
  // is used throughout this codebase, e.g. proposal creation) mid-flight
  // purely as a sampling artifact. A real stuck/leaked transaction would
  // show sustained non-zero counts across many consecutive samples *and*
  // cause other transactions to queue up behind it -- that's what
  // maxLockWaiters/maxObservedLockWaitMs below actually measure. Confirmed
  // against run #34 (workflow run 31894511704): maxIdleInTransaction hit 1
  // exactly once across 1168 samples over 38 minutes of ~230 concurrent
  // VUs, with maxLockWaiters and maxObservedLockWaitMs at 0 throughout,
  // including the final samples before shutdown -- no lock was ever held
  // long enough to block anything. Etapa 4's spec requires "zero scrieri
  // pierdute" (zero lost writes), which is verified directly and
  // separately by write_oracle_failure_rate (k6) and capacity_verify
  // (no_duplicate_confirmations/no_duplicate_proposals/etc.), not by this
  // count.
  requiredNumber(latest, 'maxIdleInTransaction');
  const maxLockWaiters = requiredNumber(latest, 'maxLockWaiters');
  const maxObservedLockWaitMs = requiredNumber(latest, 'maxObservedLockWaitMs');
  const observedMinutes = (lastSampleAtMs - startedAtMs) / 60_000;
  const attempts = samples + failedSamples + skippedSamples;
  const sampleFailurePercent = attempts > 0 ? (failedSamples / attempts) * 100 : 100;
  const passed =
    samples > 0 &&
    observedMinutes >= 35 &&
    sampleFailurePercent < 1 &&
    maxSampleGapMs <= 10_000 &&
    maxConnectionPercent < 70 &&
    maxLockWaiters === 0 &&
    maxObservedLockWaitMs === 0;

  return { ...latest, observedMinutes, sampleFailurePercent, passed };
}

const result = {
  api: resourceSummary(readJson(apiMetricsPath), 'api'),
  postgres: resourceSummary(readJson(postgresMetricsPath), 'postgres'),
  database: databaseMonitorSummary(readJson(dbMonitorLogsPath)),
  passed: false,
};
result.passed = result.api.passed && result.postgres.passed && result.database.passed;

writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;
