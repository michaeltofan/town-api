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

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function metricSeries(document: unknown, name: string): MetricSample[] {
  const root = object(document);
  const data = object(root?.data);
  const candidate = root?.metrics ?? data?.metrics;
  const metrics = Array.isArray(candidate) ? candidate : [];
  const metric = metrics.map(object).find((entry) => {
    const measurement = entry?.measurement ?? entry?.name ?? '';
    return String(measurement).toUpperCase().includes(name);
  });
  const samplesCandidate = metric?.samples ?? metric?.data;
  const samples = Array.isArray(samplesCandidate) ? samplesCandidate : [];
  return samples
    .map(object)
    .filter((sample): sample is JsonObject => sample !== null)
    .map((sample) => ({
      timestamp: Date.parse(String(sample.timestamp ?? sample.time ?? '')),
      value: Number(sample.value),
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

function resourceSummary(document: unknown, service: 'api' | 'postgres') {
  const cpuUsage = metricSeries(document, 'CPU_USAGE');
  const cpuLimits = metricSeries(document, 'CPU_LIMIT').filter((sample) => sample.value > 0);
  const memoryUsage = metricSeries(document, 'MEMORY_USAGE');
  const memoryLimits = metricSeries(document, 'MEMORY_LIMIT').filter(
    (sample) => sample.value > 0,
  );
  if (!cpuUsage.length || !cpuLimits.length || !memoryUsage.length || !memoryLimits.length) {
    throw new Error(`${service}: missing CPU or memory usage/limit samples`);
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

  const startedAtMs = Date.parse(String(latest.startedAt ?? ''));
  const lastSampleAtMs = Date.parse(String(latest.lastSampleAt ?? ''));
  const samples = requiredNumber(latest, 'samples');
  const failedSamples = requiredNumber(latest, 'failedSamples');
  const skippedSamples = requiredNumber(latest, 'skippedSamples');
  const maxSampleGapMs = requiredNumber(latest, 'maxSampleGapMs');
  const maxConnectionPercent = requiredNumber(latest, 'maxConnectionPercent');
  const maxIdleInTransaction = requiredNumber(latest, 'maxIdleInTransaction');
  const observedMinutes = (lastSampleAtMs - startedAtMs) / 60_000;
  const attempts = samples + failedSamples + skippedSamples;
  const sampleFailurePercent = attempts > 0 ? (failedSamples / attempts) * 100 : 100;
  const passed =
    samples > 0 &&
    observedMinutes >= 35 &&
    sampleFailurePercent < 1 &&
    maxSampleGapMs <= 10_000 &&
    maxConnectionPercent < 70 &&
    maxIdleInTransaction === 0;

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
