import { describe, expect, it } from 'vitest';
import type { Hex } from '../sim/hex';
import type { Unit, UnitKind } from '../sim/types';
import type { LogEntry } from '../state/match';
import { confirmedKills, tallyAssets } from './stats';

const hex = (col: number, row: number): Hex => ({
  q: col,
  r: row - (col - (col & 1)) / 2,
});

function unit(id: string, kind: UnitKind, hp = 1, destroyed = false): Unit {
  return { id, owner: 'p1', kind, position: hex(5, 15), hp, destroyed };
}

const FULL: Unit[] = [
  unit('p1-launcher-1', 'launcher'),
  unit('p1-launcher-2', 'launcher'),
  unit('p1-launcher-3', 'launcher'),
  unit('p1-drone', 'drone'),
  unit('p1-bunker', 'bunker', 2),
  unit('p1-decoy', 'decoy'),
  unit('p1-interceptor', 'interceptor'),
];

describe('tallyAssets', () => {
  it('counts a full-strength side', () => {
    expect(tallyAssets(FULL, 'p1')).toEqual({
      launchers: { alive: 3, total: 3 },
      bunker: { hp: 2, max: 2 },
      decoyAlive: true,
      baseAlive: true,
    });
  });

  it('counts losses and bunker damage', () => {
    const units = FULL.map((u) => {
      if (u.id === 'p1-launcher-2') return { ...u, hp: 0, destroyed: true };
      if (u.id === 'p1-decoy') return { ...u, hp: 0, destroyed: true };
      if (u.id === 'p1-bunker') return { ...u, hp: 1 };
      return u;
    });
    expect(tallyAssets(units, 'p1')).toEqual({
      launchers: { alive: 2, total: 3 },
      bunker: { hp: 1, max: 2 },
      decoyAlive: false,
      baseAlive: true,
    });
  });

  it('reports a destroyed bunker as 0 hits left', () => {
    const units = FULL.map((u) => (u.kind === 'bunker' ? { ...u, hp: 0, destroyed: true } : u));
    expect(tallyAssets(units, 'p1').bunker).toEqual({ hp: 0, max: 2 });
  });

  it('ignores units that are not the viewer’s', () => {
    const enemy: Unit = { ...unit('p2-launcher-1', 'launcher'), owner: 'p2' };
    expect(tallyAssets([...FULL, enemy], 'p1').launchers).toEqual({ alive: 3, total: 3 });
  });
});

describe('confirmedKills', () => {
  it('counts enemy units destroyed and enemy drones shot down, oldest first', () => {
    const log: LogEntry[] = [
      { round: 2, event: { type: 'UNIT_DESTROYED', unitId: 'p2-launcher-1', kind: 'launcher', hex: hex(3, 4) } },
      { round: 3, event: { type: 'DRONE_DOWNED', unitId: 'p2-drone', owner: 'p2', hex: hex(6, 12) } },
      { round: 5, event: { type: 'UNIT_DESTROYED', unitId: 'p2-decoy', kind: 'decoy', hex: hex(9, 3) } },
    ];
    expect(confirmedKills(log, FULL, 'p1')).toEqual([
      { round: 2, kind: 'launcher', hex: hex(3, 4) },
      { round: 3, kind: 'drone', hex: hex(6, 12) },
      { round: 5, kind: 'decoy', hex: hex(9, 3) },
    ]);
  });

  it('never counts the viewer’s own losses', () => {
    const log: LogEntry[] = [
      { round: 2, event: { type: 'UNIT_DESTROYED', unitId: 'p1-launcher-1', kind: 'launcher', hex: hex(3, 14) } },
      { round: 3, event: { type: 'DRONE_DOWNED', unitId: 'p1-drone', owner: 'p1', hex: hex(6, 6) } },
    ];
    expect(confirmedKills(log, FULL, 'p1')).toEqual([]);
  });

  it('does not count a bunker hit that was not a kill', () => {
    // BUNKER_HIT only ever reaches the bunker's owner; even so it is not a kill.
    const log: LogEntry[] = [
      { round: 4, event: { type: 'BUNKER_HIT', unitId: 'p1-bunker', owner: 'p1', hex: hex(5, 15), hpRemaining: 1 } },
      { round: 4, event: { type: 'IMPACT', missileId: 'r4@3,3', hex: hex(3, 3) } },
    ];
    expect(confirmedKills(log, FULL, 'p1')).toEqual([]);
  });
});
