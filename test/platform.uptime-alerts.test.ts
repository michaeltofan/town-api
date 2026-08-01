import { describe, expect, it } from 'vitest';
import {
  alertSeverityForStatus,
  deriveOverallStatus,
  isUnhealthyComponentStatus,
  sampleIsHealthy,
  sanitizeComponentDetail,
} from '../src/platform/services/uptime-alerts.js';
import type { PlatformOperationalComponents } from '../src/platform/services/status-checks.js';

function components(
  overrides: Partial<Record<keyof PlatformOperationalComponents, string>> = {},
): PlatformOperationalComponents {
  const status = (name: keyof PlatformOperationalComponents) =>
    (overrides[name] ??
      'ok') as PlatformOperationalComponents[keyof PlatformOperationalComponents]['status'];
  return {
    api: { status: status('api'), detail: null },
    database: { status: status('database'), detail: null },
    email: { status: status('email'), detail: null },
    stripe: { status: status('stripe'), detail: null },
  };
}

describe('platform uptime alert helpers', () => {
  it('classifies unhealthy component statuses', () => {
    expect(isUnhealthyComponentStatus('ok')).toBe(false);
    expect(isUnhealthyComponentStatus('disabled')).toBe(false);
    expect(isUnhealthyComponentStatus('degraded')).toBe(true);
    expect(isUnhealthyComponentStatus('fail')).toBe(true);
  });

  it('maps severity from status', () => {
    expect(alertSeverityForStatus('degraded')).toBe('warning');
    expect(alertSeverityForStatus('misconfigured')).toBe('warning');
    expect(alertSeverityForStatus('timeout')).toBe('critical');
    expect(alertSeverityForStatus('fail')).toBe('critical');
  });

  it('derives overall status from the worst non-disabled component', () => {
    expect(deriveOverallStatus(components())).toBe('ok');
    expect(deriveOverallStatus(components({ email: 'disabled', stripe: 'disabled' }))).toBe('ok');
    expect(deriveOverallStatus(components({ email: 'degraded', stripe: 'fail' }))).toBe('fail');
    expect(deriveOverallStatus(components({ database: 'timeout' }))).toBe('timeout');
    expect(sampleIsHealthy('ok')).toBe(true);
    expect(sampleIsHealthy('degraded')).toBe(false);
  });

  it('sanitizes component details without leaking secrets', () => {
    expect(sanitizeComponentDetail('resend_reachable')).toBe('resend_reachable');
    expect(sanitizeComponentDetail('token=abc')).toBe('redacted');
    expect(sanitizeComponentDetail('a'.repeat(200))?.endsWith('...')).toBe(true);
    expect(sanitizeComponentDetail(null)).toBeNull();
  });
});
