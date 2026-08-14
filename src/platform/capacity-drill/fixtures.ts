/**
 * Etapa 4 capacity drill fixed identity -- ISOLATED, TEMPORARY DATABASE ONLY.
 *
 * Every ID/slug/email/password here is a fixed constant, not generated per
 * run. This is safe and deliberate specifically because this whole
 * mechanism only ever runs against a brand-new, empty Postgres created
 * fresh for one drill and deleted as a whole service afterward (see
 * docs/operations/CAPACITY_DRILL_RUNBOOK.md) -- there is never a second
 * writer, never a collision, and never any real user data anywhere near
 * this database. Fixed IDs mean the setup phase (running inside a
 * temporary Railway service) and the k6 phase (running on the GitHub
 * Actions runner, unable to import this module) can agree on exactly what
 * exists without passing a manifest file between two different machines --
 * `loadtest/capacity-1000.js` mirrors these constants in plain JS for
 * exactly that reason; keep the two in sync by hand if either changes.
 *
 * The shared password below is not a secret: it is never used against
 * staging, production, or any database that survives past one drill run.
 */

export const CAPACITY_DRILL_PASSWORD = 'CapacityDrill-2026-Isolated!';

export const MAIN_SIGNAL_COUNT_A = 20;
export const MAIN_SIGNAL_COUNT_B = 3;
export const ARENA_SIGNAL_COUNT = 8;
export const ACCOUNT_COUNT_A = 225;
export const ACCOUNT_COUNT_B = 25;
export const ARENA_ACCOUNT_COUNT = 40;

export const ADVANCER_COUNT = 5; // distinct actors needed to cross each civic-process stage threshold

function fixedId(group: string, index: number): string {
  return `00000000-0000-4000-${group}-${index.toString().padStart(12, '0')}`;
}

export const COMMUNITY_A = { id: fixedId('c001', 1), slug: 'capacity-drill-a' };
export const COMMUNITY_B = { id: fixedId('c002', 1), slug: 'capacity-drill-b' };
export const ARENA_COMMUNITY = { id: fixedId('c003', 1), slug: 'capacity-drill-arena' };

export function mainSignalIdsA(): string[] {
  return Array.from({ length: MAIN_SIGNAL_COUNT_A }, (_unused, i) => fixedId('c101', i + 1));
}

export function mainSignalIdsB(): string[] {
  return Array.from({ length: MAIN_SIGNAL_COUNT_B }, (_unused, i) => fixedId('c102', i + 1));
}

export function arenaSignalIds(): string[] {
  return Array.from({ length: ARENA_SIGNAL_COUNT }, (_unused, i) => fixedId('c103', i + 1));
}

export type FixedAccount = { accountId: string; actorId: string; email: string };

export function mainAccountsA(): FixedAccount[] {
  return Array.from({ length: ACCOUNT_COUNT_A }, (_unused, i) => ({
    accountId: fixedId('c201', i + 1),
    actorId: fixedId('c301', i + 1),
    email: `capacity-a-${String(i + 1)}@loadtest.internal`,
  }));
}

export function mainAccountsB(): FixedAccount[] {
  return Array.from({ length: ACCOUNT_COUNT_B }, (_unused, i) => ({
    accountId: fixedId('c202', i + 1),
    actorId: fixedId('c302', i + 1),
    email: `capacity-b-${String(i + 1)}@loadtest.internal`,
  }));
}

export function arenaAccounts(): FixedAccount[] {
  return Array.from({ length: ARENA_ACCOUNT_COUNT }, (_unused, i) => ({
    accountId: fixedId('c203', i + 1),
    actorId: fixedId('c303', i + 1),
    email: `capacity-arena-${String(i + 1)}@loadtest.internal`,
  }));
}
