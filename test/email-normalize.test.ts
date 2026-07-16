import { describe, expect, it } from 'vitest';
import { normalizeEmail } from '../src/identity/email-normalize.js';

describe('normalizeEmail', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com');
  });

  it('lowercases the domain only', () => {
    expect(normalizeEmail('User.Name@Example.COM')).toBe('User.Name@example.com');
  });

  it('preserves local-part casing', () => {
    expect(normalizeEmail('MixedCase@example.com')).toBe('MixedCase@example.com');
  });

  it('preserves dots in the local-part', () => {
    expect(normalizeEmail('first.last@example.com')).toBe('first.last@example.com');
  });

  it('preserves plus tags', () => {
    expect(normalizeEmail('user+tag@example.com')).toBe('user+tag@example.com');
  });

  it('keeps provider-specific addresses distinct without Gmail-style rewriting', () => {
    expect(normalizeEmail('a.b+tag@gmail.com')).toBe('a.b+tag@gmail.com');
    expect(normalizeEmail('ab@gmail.com')).toBe('ab@gmail.com');
    expect(normalizeEmail('a.b+tag@gmail.com')).not.toBe(normalizeEmail('ab@gmail.com'));
  });

  it('rejects malformed inputs', () => {
    expect(() => normalizeEmail('not-an-email')).toThrow(/local-part and domain/);
    expect(() => normalizeEmail('@example.com')).toThrow(/local-part and domain/);
    expect(() => normalizeEmail('user@')).toThrow(/local-part and domain/);
  });
});
