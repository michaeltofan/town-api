#!/usr/bin/env node
// Etapa 5 Step 2 -- turns the real measurements collected by
// media-upload-probe.yml (server-echoed byteSize from deployment logs,
// request duration from the k6 summary) into a Cloudflare R2 cost estimate.
//
// The byte sizes and durations below are real, measured numbers for this
// run. The monthly *usage volume* (uploads/user/month) is not measurable
// from a single probe run -- it is a stated, labeled assumption about the
// planned user wave, kept separate from the measured numbers so the two are
// never confused with each other.

import { readFileSync } from 'node:fs';

type JsonObject = Record<string, unknown>;

const [logsPath, k6SummaryPath] = process.argv.slice(2);
if (!logsPath || !k6SummaryPath) {
  throw new Error('usage: media-probe-cost-report.ts <deployment-logs.json> <k6-summary.json>');
}

function object(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const logsResponse = readJson(logsPath);
const k6Summary = readJson(k6SummaryPath);

const root = object(logsResponse);
const data = object(root?.data);
const logsCandidate = data?.deploymentLogs ?? root?.deploymentLogs;
const logs = Array.isArray(logsCandidate) ? logsCandidate : [];

// Mirrors databaseMonitorSummary() in capacity-evaluate-observability.ts:
// Railway's log ingestion sometimes flattens a nested top-level JSON key
// into a same-named `attributes` entry (value = JSON string of the nested
// object), and sometimes leaves the raw JSON line intact in `message`
// instead -- both cases are handled there for `capacityDbMonitor`, so the
// same two paths are checked here for `mediaUpload` rather than assuming
// only one of them occurs.
function parseNestedRecord(value: unknown): JsonObject | null {
  if (typeof value !== 'string') return null;
  try {
    return object(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

const records: JsonObject[] = [];
for (const logValue of logs) {
  const log = object(logValue);
  const attributes = Array.isArray(log?.attributes) ? log.attributes : [];
  // Try the attributes path first; only fall back to parsing `message` for
  // this same log line if attributes yielded nothing, so a line that
  // happens to satisfy both paths is never counted twice.
  let foundInAttributes = false;
  for (const attributeValue of attributes) {
    const attribute = object(attributeValue);
    if (attribute?.key !== 'mediaUpload') continue;
    const parsed = parseNestedRecord(attribute.value);
    if (parsed) {
      records.push(parsed);
      foundInAttributes = true;
    }
  }
  if (
    !foundInAttributes &&
    typeof log?.message === 'string' &&
    log.message.includes('mediaUpload')
  ) {
    const parsedMessage = parseNestedRecord(log.message);
    const parsedRecord = object(parsedMessage?.mediaUpload);
    if (parsedRecord) records.push(parsedRecord);
  }
}

const byRoute = new Map<string, number[]>();
for (const record of records) {
  const route = typeof record.route === 'string' ? record.route : null;
  const byteSize = Number(record.byteSize);
  if (!route || !Number.isFinite(byteSize)) continue;
  if (!byRoute.has(route)) byRoute.set(route, []);
  byRoute.get(route)?.push(byteSize);
}

if (byRoute.size === 0) {
  throw new Error('No mediaUpload log records with a parseable route/byteSize were found.');
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    minBytes: sorted[0] ?? 0,
    maxBytes: sorted[sorted.length - 1] ?? 0,
    avgBytes: sum / sorted.length,
  };
}

// Published Cloudflare R2 pricing (Standard storage class), confirmed
// against cloudflare.com/r2 pricing during Etapa 5 planning:
const R2_STORAGE_USD_PER_GB_MONTH = 0.015;
const R2_CLASS_A_USD_PER_MILLION = 4.5; // writes: PutObject (both routes)
const R2_CLASS_B_USD_PER_MILLION = 0.36; // reads: GetObject (member-signal public reads + discussion private reads)
// R2 has zero egress fees -- no per-GB serving cost, unlike S3/GCS.

// Stated assumption, not a measurement: usage volume for the Etapa 4
// planned wave of 1,000 users. Kept intentionally conservative and labeled
// so it can be revised without touching the measured byte-size numbers
// above. Chosen as a round, defensible civic-engagement rate: most users
// browse without ever publishing a signal or joining a discussion.
const ASSUMED_USERS = 1000;
const ASSUMED_SIGNAL_PHOTOS_PER_USER_PER_MONTH = 1;
const ASSUMED_DISCUSSION_MEDIA_PER_USER_PER_MONTH = 2;
// Each published signal photo / discussion media item is assumed read back
// (feed views, detail views) this many times before it stops being fetched.
const ASSUMED_READS_PER_UPLOAD = 20;

function report(routeLabel: string, values: number[] | undefined, uploadsPerUserPerMonth: number) {
  if (!values) return null;
  const s = stats(values);
  const monthlyUploads = ASSUMED_USERS * uploadsPerUserPerMonth;
  const monthlyBytes = monthlyUploads * s.avgBytes;
  const monthlyGb = monthlyBytes / 1024 ** 3;
  const storageUsd = monthlyGb * R2_STORAGE_USD_PER_GB_MONTH;
  const writeOpsUsd = (monthlyUploads / 1_000_000) * R2_CLASS_A_USD_PER_MILLION;
  const readOpsUsd =
    ((monthlyUploads * ASSUMED_READS_PER_UPLOAD) / 1_000_000) * R2_CLASS_B_USD_PER_MILLION;
  return { routeLabel, s, monthlyUploads, monthlyGb, storageUsd, writeOpsUsd, readOpsUsd };
}

const rows = [
  report('member_signal', byRoute.get('member_signal'), ASSUMED_SIGNAL_PHOTOS_PER_USER_PER_MONTH),
  report(
    'discussion_contribution',
    byRoute.get('discussion_contribution'),
    ASSUMED_DISCUSSION_MEDIA_PER_USER_PER_MONTH,
  ),
].filter((row): row is NonNullable<typeof row> => row !== null);

const totalStorageUsd = rows.reduce((a, r) => a + r.storageUsd, 0);
const totalWriteOpsUsd = rows.reduce((a, r) => a + r.writeOpsUsd, 0);
const totalReadOpsUsd = rows.reduce((a, r) => a + r.readOpsUsd, 0);
const totalUsd = totalStorageUsd + totalWriteOpsUsd + totalReadOpsUsd;

const k6Root = object(k6Summary);
const metrics = object(k6Root?.metrics);
const durationMetric = object(metrics?.http_req_duration);
const durationValues = object(durationMetric?.values);

const lines: string[] = [];
lines.push('# Etapa 5 -- media upload cost/traffic measurement\n');
lines.push('## Real, measured numbers (this run)\n');
lines.push('| route | requests | min bytes | avg bytes | max bytes |');
lines.push('|---|---|---|---|---|');
for (const r of rows) {
  lines.push(
    `| ${r.routeLabel} | ${String(r.s.count)} | ${String(r.s.minBytes)} | ${String(Math.round(r.s.avgBytes))} | ${String(r.s.maxBytes)} |`,
  );
}
lines.push('');
if (durationValues) {
  const avg = Number(durationValues.avg);
  const p90 = Number(durationValues['p(90)']);
  const p95 = Number(durationValues['p(95)']);
  const max = Number(durationValues.max);
  lines.push('HTTP request duration across the probe (all upload requests, both routes):');
  lines.push(
    `- avg: ${avg.toFixed(1)}ms, p90: ${p90.toFixed(1)}ms, p95: ${p95.toFixed(1)}ms, max: ${max.toFixed(1)}ms\n`,
  );
}

lines.push('## Projected monthly Cloudflare R2 cost\n');
lines.push(
  `Assumption (not measured): ${String(ASSUMED_USERS)} users, ${String(ASSUMED_SIGNAL_PHOTOS_PER_USER_PER_MONTH)} signal photo/user/month, ` +
    `${String(ASSUMED_DISCUSSION_MEDIA_PER_USER_PER_MONTH)} discussion media/user/month, ${String(ASSUMED_READS_PER_UPLOAD)} reads/upload. ` +
    'Byte sizes and durations above are real measurements; this volume is a stated planning assumption.\n',
);
lines.push(
  '| route | uploads/month | storage GB/month | storage $/mo | write ops $/mo | read ops $/mo |',
);
lines.push('|---|---|---|---|---|---|');
for (const r of rows) {
  lines.push(
    `| ${r.routeLabel} | ${String(r.monthlyUploads)} | ${r.monthlyGb.toFixed(3)} | $${r.storageUsd.toFixed(2)} | $${r.writeOpsUsd.toFixed(2)} | $${r.readOpsUsd.toFixed(2)} |`,
  );
}
lines.push('');
lines.push(
  `**Total estimated R2 cost: $${totalUsd.toFixed(2)}/month** ` +
    `(storage $${totalStorageUsd.toFixed(2)} + write ops $${totalWriteOpsUsd.toFixed(2)} + read ops $${totalReadOpsUsd.toFixed(2)}). ` +
    'R2 has zero egress fees, so no additional per-GB serving cost applies.\n',
);

process.stdout.write(lines.join('\n') + '\n');
