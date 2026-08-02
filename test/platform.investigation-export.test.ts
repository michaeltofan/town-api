import { describe, expect, it } from 'vitest';
import { PLATFORM_INVESTIGATION_EXPORT_AUDIT_LIMIT } from '../src/platform/services/investigation-export.js';

describe('platform investigation export', () => {
  it('keeps the support pack audit slice bounded', () => {
    expect(PLATFORM_INVESTIGATION_EXPORT_AUDIT_LIMIT).toBe(50);
  });
});
