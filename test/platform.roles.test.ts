import { describe, expect, it } from 'vitest';
import { operatorHasCapability, roleRank } from '../src/platform/roles.js';

describe('platform operator roles', () => {
  it('orders roles by increasing capability', () => {
    expect(roleRank('viewer')).toBeLessThan(roleRank('investigator'));
    expect(roleRank('investigator')).toBeLessThan(roleRank('moderator'));
    expect(roleRank('moderator')).toBeLessThan(roleRank('account_admin'));
    expect(roleRank('account_admin')).toBeLessThan(roleRank('ops_admin'));
    expect(roleRank('ops_admin')).toBeLessThan(roleRank('role_admin'));
  });

  it('grants manage_accounts only from account_admin upward', () => {
    expect(operatorHasCapability('moderator', 'manage_accounts')).toBe(false);
    expect(operatorHasCapability('account_admin', 'manage_accounts')).toBe(true);
    expect(operatorHasCapability('role_admin', 'manage_accounts')).toBe(true);
  });

  it('grants manage_operators only to role_admin', () => {
    expect(operatorHasCapability('ops_admin', 'manage_operators')).toBe(false);
    expect(operatorHasCapability('role_admin', 'manage_operators')).toBe(true);
  });

  it('grants manage_memberships only from ops_admin upward', () => {
    expect(operatorHasCapability('account_admin', 'manage_memberships')).toBe(false);
    expect(operatorHasCapability('ops_admin', 'manage_memberships')).toBe(true);
    expect(operatorHasCapability('role_admin', 'manage_memberships')).toBe(true);
  });

  it('grants manage_alerts only from ops_admin upward', () => {
    expect(operatorHasCapability('account_admin', 'manage_alerts')).toBe(false);
    expect(operatorHasCapability('ops_admin', 'manage_alerts')).toBe(true);
    expect(operatorHasCapability('role_admin', 'manage_alerts')).toBe(true);
  });

  it('allows investigators to read payments and audit', () => {
    expect(operatorHasCapability('viewer', 'read_payments')).toBe(false);
    expect(operatorHasCapability('investigator', 'read_payments')).toBe(true);
    expect(operatorHasCapability('investigator', 'read_audit')).toBe(true);
  });
});
