import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { MembershipStatusSchema } from '../src/membership/schemas.js';

describe('MembershipStatusSchema', () => {
  it('accepts suspended', () => {
    expect(Value.Check(MembershipStatusSchema, 'suspended')).toBe(true);
  });
});
