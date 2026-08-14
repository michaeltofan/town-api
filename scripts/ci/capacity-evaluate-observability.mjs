#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';

const [apiMetricsPath, postgresMetricsPath, dbMonitorLogsPath, outputPath] = process.argv.slice(2);
if (!apiMetricsPath || !postgresMetricsPath || !dbMonitorLogsPath || !outputPath) {
  throw new Error(
    'usage: capacity-evaluate-observability.mjs <api-metrics.json> <postgres-metrics.json> <db-monitor-logs.json> <output.json>',
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function metricSeries(document, name) {
  const metrics = Array.isArray(document?.metrics)
    ? document.metrics
    : Array.isArray(document?.data?.metrics)
      ? document.data.metrics
      : [];
  const metric = metrics.find((candidate) =>
    String(candidate?.measurement ?? candidate?.name ?? '')
      .toUpperCase()
      .includes(name),
  );
  const samples = metric?.samples ?? metric?.data ?? [];
  return samples
    .map((sample) => ({
      timestamp: Date.parse(sample.timestamp ?? sample.time ?? ''),
      value: Number(sample.value),
    }))
    .filter((sample) => Number.isFinite(sample.value));
}

function nearestLimit(usageSample, limits) {
  const timestamped = limits
    .filter((sample) => Number.isFinite(sample.timestamp) && sample.timestamp <= usageSample.timestamp)
    .at(-1);
  return timestamped ?? limits.at(-1);
}

function resourceSummary(document, service) {
  const cpuUsage = metricSeries(document, 'CPU_USAGE');
  const cpuLimits = metricSeries(document, 'CPU_LIMIT').filter((sample) => sample.value > 0);
  const memoryUsage = metricSeries(document, 'MEMORY_USAGE');
  const memoryLimits = metricSeries(document, 'MEMORY_LIMIT').filter((sample) => sample.value > 0);
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
    passed:
      cpuAveragePercent < 70 && cpuPeakPercent < 85 && memoryPeakPercent < 80,
  };
}

function databaseMonitorSummary(document) {
  const logs = document?.data?.deploymentLogs ?? document?.deploymentLogs ?? [];
  const summaries = [];
  for (const log of logs) {
    for (const attribute of log?.attributes ?? []) {
      if (attribute?.key !== 'capacityDbMonitor') continue;
      try {
        summaries.push(JSON.parse(attribute.value));
      } catch {
        // A malformed monitor attribute is ignored; absence of valid samples fails below.
      }
    }
    if (typeof log?.message === 'string' && log.message.includes('capacityDbMonitor')) {
      try {
        const parsed = JSON.parse(log.message);
        if (parsed?.capacityDbMonitor) summaries.push(parsed.capacityDbMonitor);
      } catch {
        // Railway normally parses JSON log attributes; message parsing is only a fallback.
      }
    }
  }
  if (!summaries.length) throw new Error('no capacityDbMonitor records found');

  const latest = summaries.at(-1);
  const startedAtMs = Date.parse(latest.startedAt);
  const lastSampleAtMs = Date.parse(latest.lastSampleAt);
  const observedMinutes = (lastSampleAtMs - startedAtMs) / 60_000;
  const attempts = latest.samples + latest.failedSamples + latest.skippedSamples;
  const sampleFailurePercent = attempts > 0 ? (latest.failedSamples / attempts) * 100 : 100;
  const passed =
    latest.samples > 0 &&
    observedMinutes >= 35 &&
    sampleFailurePercent < 1 &&
    latest.maxSampleGapMs <= 10_000 &&
    latest.maxConnectionPercent < 70 &&
    latest.maxIdleInTransaction === 0;

  return { ...latest, observedMinutes, sampleFailurePercent, passed };
}

const result = {
  api: resourceSummary(readJson(apiMetricsPath), 'api'),
  postgres: resourceSummary(readJson(postgresMetricsPath), 'postgres'),
  database: databaseMonitorSummary(readJson(dbMonitorLogsPath)),
};
result.passed = result.api.passed && result.postgres.passed && result.database.passed;

writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;
