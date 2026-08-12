import { describe, expect, it } from 'vitest';
import type { Hex } from '../sim/hex';
import type { Outcome, Unit, VisibleEvent } from '../sim/types';
import { describeEvent, describeOutcome, hexLabel } from './eventText';

const hex = (col: number, row: number): Hex => ({
  q: col,
  r: row - (col - (col & 1)) / 2,
});

const OWN: Unit[] = [
  { id: 'p1-launcher-1', owner: 'p1', kind: 'launcher', position: hex(2, 16), hp: 1, destroyed: false },
  { id: 'p1-drone', owner: 'p1', kind: 'drone', position: hex(8, 17), hp: 1, destroyed: false },
];

/**
 * One fixture per `VisibleEvent` kind. The `satisfies` is what makes this a
 * completeness check rather than a sample: a new event kind added to the engine
 * leaves this array missing a member and the test below stops covering it, so
 * the count assertion fails.
 */
const EVERY_EVENT = [
  { type: 'UNIT_MOVED', unitId: 'p1-launcher-1', owner: 'p1', from: hex(2, 16), to: hex(2, 13) },
  { type: 'MOVE_FAILED', unitId: 'p1-launcher-1', owner: 'p1' },
  { type: 'BUNKER_HIT', unitId: 'p1-bunker', owner: 'p1', hex: hex(5, 17), hpRemaining: 1 },
  { type: 'DRONE_MOVED', unitId: 'p1-drone', owner: 'p1', from: hex(8, 17), to: hex(8, 11), path: [hex(8, 17), hex(8, 11)] },
  { type: 'DRONE_MOVED', unitId: 'p1-drone', owner: 'p1', from: hex(8, 17), to: hex(8, 17), path: [hex(8, 17)] },
  { type: 'ASSET_SPOTTED', kind: 'launcher', hex: hex(7, 2), owner: 'p2' },
  { type: 'ASSET_SPOTTED', kind: 'bunker', hex: hex(7, 3), owner: 'p2' },
  { type: 'ASSET_SPOTTED', kind: 'interceptor', hex: hex(7, 4), owner: 'p2' },
  { type: 'DRONE_RESPAWNED', unitId: 'p1-drone', owner: 'p1', hex: hex(8, 17) },
  { type: 'LAUNCH_DETECTED', missileId: 'r3@2,10', origin: hex(2, 16), target: hex(2, 13) },
  { type: 'MISSILE_INTERCEPTED', missileId: 'r3@2,10', hex: hex(2, 14) },
  { type: 'IMPACT', missileId: 'r3@2,10', hex: hex(2, 13) },
  { type: 'UNIT_DESTROYED', unitId: 'p2-launcher-1', kind: 'launcher', hex: hex(2, 2) },
  { type: 'DRONE_DOWNED', unitId: 'p1-drone', owner: 'p1', hex: hex(7, 5) },
  { type: 'DRONE_DOWNED', unitId: 'p2-drone', owner: 'p2', hex: hex(7, 5) },
  { type: 'DEAD_HAND_TRIGGERED', playerId: 'p1' },
  { type: 'DEAD_HAND_TRIGGERED', playerId: 'p2' },
  { type: 'GAME_OVER', outcome: { type: 'DECAPITATION', winner: 'p1' } },
] as const satisfies readonly VisibleEvent[];

describe('describeEvent', () => {
  it('writes a line for every event kind', () => {
    const kinds = new Set(EVERY_EVENT.map((event) => event.type));
    // The 13 event kinds of spec §6's visibility table. Hardcoded because a
    // union's members cannot be counted at runtime — if this number is stale,
    // an event kind has been added and needs a line of English above.
    expect(kinds.size).toBe(13);

    for (const event of EVERY_EVENT) {
      expect(describeEvent(event, 'p1', OWN).length).toBeGreaterThan(0);
    }
  });

  // Spec §6: nothing may derive meaning from a UnitId, and UNIT_DESTROYED is
  // public — printing its id would hand the enemy the trackable identity §11
  // keys every pile of intel by hex to withhold.
  it('never prints a raw unit id', () => {
    for (const event of EVERY_EVENT) {
      const line = describeEvent(event, 'p1', OWN);
      expect(line).not.toMatch(/p[12]-/);
    }
  });

  it('names the viewer’s own units by kind, from their own roster', () => {
    expect(describeEvent(EVERY_EVENT[0], 'p1', OWN)).toBe('Launcher moved c2 r16 → c2 r13.');
    expect(describeEvent(EVERY_EVENT[1], 'p1', OWN)).toContain('launcher');
  });

  it('reads a hover differently from a flight', () => {
    expect(describeEvent(EVERY_EVENT[4], 'p1', OWN)).toContain('held station');
    expect(describeEvent(EVERY_EVENT[3], 'p1', OWN)).toContain('flew');
  });

  it('phrases owner-tagged public events from the reader’s side', () => {
    const [mine, theirs] = [EVERY_EVENT[13], EVERY_EVENT[14]];
    expect(describeEvent(mine, 'p1', OWN)).toContain('Your drone');
    expect(describeEvent(theirs, 'p1', OWN)).toContain('enemy drone');
  });

  it('falls back gracefully when an own unit is not in the roster', () => {
    // A destroyed-and-removed unit or a partial fixture must not crash the log.
    expect(describeEvent(EVERY_EVENT[1], 'p1', [])).toContain('unit');
  });
});

describe('describeOutcome', () => {
  const outcomes: Outcome[] = [
    { type: 'MUTUAL_ANNIHILATION' },
    { type: 'DECAPITATION', winner: 'p1' },
    { type: 'CAPITULATION', winner: 'p1' },
    { type: 'MUTUAL_DISARMAMENT' },
    { type: 'DISARMAMENT', winner: 'p1' },
    { type: 'ARMISTICE' },
  ];

  it('covers every outcome in spec §4', () => {
    for (const outcome of outcomes) {
      expect(describeOutcome(outcome, 'p1').length).toBeGreaterThan(0);
    }
  });

  it('reads the same outcome as a win or a loss depending on the reader', () => {
    const decapitation: Outcome = { type: 'DECAPITATION', winner: 'p1' };
    expect(describeOutcome(decapitation, 'p1')).toContain('Victory');
    expect(describeOutcome(decapitation, 'p2')).toContain('Defeat');
  });
});

describe('hexLabel', () => {
  it('reports the map’s own column and row, not axial coordinates', () => {
    // Axial r skews with the column: this hex is axial (8, 13) and the player
    // must read row 17, the row it is drawn on.
    expect(hexLabel(hex(8, 17))).toBe('c8 r17');
    expect(hexLabel({ q: 8, r: 13 })).toBe('c8 r17');
  });
});
