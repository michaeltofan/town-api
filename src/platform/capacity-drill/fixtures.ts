/** Deterministic fixture identities for the two consecutive capacity cycles. */

export const CAPACITY_DRILL_PASSWORD = 'CapacityDrill-2026-Isolated!';

export const MAIN_SIGNAL_COUNT_A = 20;
export const MAIN_SIGNAL_COUNT_B = 3;
export const ARENA_SIGNAL_COUNT = 8;
export const ACCOUNT_COUNT_A = 225;
export const ACCOUNT_COUNT_B = 25;
export const ARENA_ACCOUNT_COUNT = 40;
export const ADVANCER_COUNT = 5;

export type CapacityDrillCycle = 1 | 2;

export function capacityDrillCycleFromEnv(
  raw = process.env.CAPACITY_DRILL_CYCLE,
): CapacityDrillCycle {
  if (raw === undefined || raw === '' || raw === '1') return 1;
  if (raw === '2') return 2;
  throw new Error('CAPACITY_DRILL_CYCLE must be exactly 1 or 2');
}

function cycleGroup(cycle: CapacityDrillCycle, group: string): string {
  return `${cycle === 1 ? 'c' : 'd'}${group.slice(1)}`;
}

function fixedId(cycle: CapacityDrillCycle, group: string, index: number): string {
  return `00000000-0000-4000-${cycleGroup(cycle, group)}-${index.toString().padStart(12, '0')}`;
}

function cycleSuffix(cycle: CapacityDrillCycle): string {
  return cycle === 1 ? '' : '-cycle-2';
}

export function communityA(cycle: CapacityDrillCycle = 1) {
  return { id: fixedId(cycle, 'c001', 1), slug: `capacity-drill-a${cycleSuffix(cycle)}` };
}

export function communityB(cycle: CapacityDrillCycle = 1) {
  return { id: fixedId(cycle, 'c002', 1), slug: `capacity-drill-b${cycleSuffix(cycle)}` };
}

export function arenaCommunity(cycle: CapacityDrillCycle = 1) {
  return { id: fixedId(cycle, 'c003', 1), slug: `capacity-drill-arena${cycleSuffix(cycle)}` };
}

export const COMMUNITY_A = communityA();
export const COMMUNITY_B = communityB();
export const ARENA_COMMUNITY = arenaCommunity();

export function mainSignalIdsA(cycle: CapacityDrillCycle = 1): string[] {
  return Array.from({ length: MAIN_SIGNAL_COUNT_A }, (_unused, i) => fixedId(cycle, 'c101', i + 1));
}

export function mainSignalIdsB(cycle: CapacityDrillCycle = 1): string[] {
  return Array.from({ length: MAIN_SIGNAL_COUNT_B }, (_unused, i) => fixedId(cycle, 'c102', i + 1));
}

export function arenaSignalIds(cycle: CapacityDrillCycle = 1): string[] {
  return Array.from({ length: ARENA_SIGNAL_COUNT }, (_unused, i) => fixedId(cycle, 'c103', i + 1));
}

export type FixedAccount = { accountId: string; actorId: string; email: string };

function fixedAccounts(
  cycle: CapacityDrillCycle,
  accountGroup: string,
  actorGroup: string,
  emailPrefix: string,
  count: number,
): FixedAccount[] {
  return Array.from({ length: count }, (_unused, i) => ({
    accountId: fixedId(cycle, accountGroup, i + 1),
    actorId: fixedId(cycle, actorGroup, i + 1),
    email: `${emailPrefix}${cycleSuffix(cycle)}-${String(i + 1)}@loadtest.internal`,
  }));
}

export function mainAccountsA(cycle: CapacityDrillCycle = 1): FixedAccount[] {
  return fixedAccounts(cycle, 'c201', 'c301', 'capacity-a', ACCOUNT_COUNT_A);
}

export function mainAccountsB(cycle: CapacityDrillCycle = 1): FixedAccount[] {
  return fixedAccounts(cycle, 'c202', 'c302', 'capacity-b', ACCOUNT_COUNT_B);
}

export function arenaAccounts(cycle: CapacityDrillCycle = 1): FixedAccount[] {
  return fixedAccounts(cycle, 'c203', 'c303', 'capacity-arena', ARENA_ACCOUNT_COUNT);
}
