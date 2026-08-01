import type { PlatformOperatorRole } from '../db/schema.js';

/**
 * Capability ranks for platform operator roles.
 * Higher rank includes all lower capabilities.
 *
 * viewer < investigator < moderator < account_admin < ops_admin < role_admin
 */
const ROLE_RANK: Record<PlatformOperatorRole, number> = {
  viewer: 10,
  investigator: 20,
  moderator: 30,
  account_admin: 40,
  ops_admin: 50,
  role_admin: 60,
};

export const PLATFORM_OPERATOR_ROLES = [
  'viewer',
  'investigator',
  'moderator',
  'account_admin',
  'ops_admin',
  'role_admin',
] as const satisfies readonly PlatformOperatorRole[];

export type PlatformCapability =
  | 'read_status'
  | 'read_accounts'
  | 'read_memberships'
  | 'read_communities'
  | 'read_signals'
  | 'read_discussions'
  | 'read_submissions'
  | 'read_audit'
  | 'read_emails'
  | 'read_payments'
  | 'moderate_signals'
  | 'manage_accounts'
  | 'manage_memberships'
  | 'manage_alerts'
  | 'manage_backup'
  | 'manage_operators';

const CAPABILITY_MIN_ROLE: Record<PlatformCapability, PlatformOperatorRole> = {
  read_status: 'viewer',
  read_accounts: 'viewer',
  read_memberships: 'viewer',
  read_communities: 'viewer',
  read_signals: 'viewer',
  read_discussions: 'viewer',
  read_submissions: 'viewer',
  read_audit: 'investigator',
  read_emails: 'investigator',
  read_payments: 'investigator',
  moderate_signals: 'moderator',
  manage_accounts: 'account_admin',
  manage_memberships: 'ops_admin',
  manage_alerts: 'ops_admin',
  manage_backup: 'ops_admin',
  manage_operators: 'role_admin',
};

export function isPlatformOperatorRole(value: string): value is PlatformOperatorRole {
  return (PLATFORM_OPERATOR_ROLES as readonly string[]).includes(value);
}

export function roleRank(role: PlatformOperatorRole): number {
  return ROLE_RANK[role];
}

export function operatorHasCapability(
  role: PlatformOperatorRole,
  capability: PlatformCapability,
): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[CAPABILITY_MIN_ROLE[capability]];
}
