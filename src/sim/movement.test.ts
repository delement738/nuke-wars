import { describe, expect, it } from 'vitest';
import {
  axialToOffset,
  distance,
  hexKey,
  neighbors,
  offsetToAxial,
  type Hex,
} from './hex';
import { generateMap, tileAt, type MapData, type Terrain, type TileData } from './map';
import { reachableHexes, validateMove } from './movement';
import type { GameState, MoveOrder, PlayerId, Unit, UnitKind } from './types';

// --- fixtures ---------------------------------------------------------------
//
// Tests build synthetic all-plains maps rather than using generateMap(), so
// terrain is controlled rather than seed-dependent. The fill order must match
// generateMap's column-major order for tileAt's index math to hold.

function makeMap(width: number, height: number): MapData {
  const tiles: TileData[] = [];
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < height; row++) {
      tiles.push({ col, row, terrain: 'plains' });
    }
  }
  return { width, height, tiles };
}

function setTerrain(map: MapData, hex: Hex, terrain: Terrain): void {
  const tile = tileAt(map, axialToOffset(hex));
  if (!tile) throw new Error(`test fixture put ${hexKey(hex)} off-map`);
  tile.terrain = terrain;
}

function makeUnit(
  id: string,
  owner: PlayerId,
  kind: UnitKind,
  position: Hex,
): Unit {
  return { id, owner, kind, position, hp: 1, maxHp: 1, destroyed: false };
}

function makeState(map: MapData, units: Unit[]): GameState {
  return {
    round: 1,
    phase: 'ORDER_PHASE',
    map,
    units,
    missileStock: { p1: { SRM: 6, MRM: 4 }, p2: { SRM: 6, MRM: 4 } },
    reconSweepsRemaining: { p1: 5, p2: 5 },
    outcome: null,
  };
}

function move(unitId: string, destination: Hex): MoveOrder {
  return { type: 'MOVE', unitId, destination };
}

/**
 * A hex comfortably inside a 21x21 map, so all 19 hexes within 2 steps are
 * on-map and edge clipping never confuses a reachability assertion.
 */
const CENTER: Hex = offsetToAxial({ col: 10, row: 10 });

function openField(units: Unit[] = []): GameState {
  return makeState(makeMap(21, 21), units);
}

// --- coordinate bridge ------------------------------------------------------

describe('offset <-> axial bridge', () => {
  it('round-trips every tile of a real generated map', () => {
    const map = generateMap();
    for (const tile of map.tiles) {
      const back = axialToOffset(offsetToAxial({ col: tile.col, row: tile.row }));
      expect(back).toEqual({ col: tile.col, row: tile.row });
    }
  });

  it('maps the origin to the origin', () => {
    expect(offsetToAxial({ col: 0, row: 0 })).toEqual({ q: 0, r: 0 });
  });

  it('leaves even columns unshifted and shifts odd ones (odd-q layout)', () => {
    // Matches GameCanvas's hexCenter: odd columns sit half a hex lower, which
    // in axial terms means the r origin only steps north every 2 columns.
    expect(offsetToAxial({ col: 0, row: 3 })).toEqual({ q: 0, r: 3 });
    expect(offsetToAxial({ col: 1, row: 3 })).toEqual({ q: 1, r: 3 });
    expect(offsetToAxial({ col: 2, row: 3 })).toEqual({ q: 2, r: 2 });
    expect(offsetToAxial({ col: 3, row: 3 })).toEqual({ q: 3, r: 2 });
  });

  it('makes offset-grid neighbours exactly one axial step apart (even column)', () => {
    // The real payoff of getting the bridge right: tiles that touch on screen
    // must be distance 1 in the sim, or movement silently misaligns with the map.
    // Even columns are unshifted, so the tiles they touch in the neighbouring
    // (lower-sitting, odd) columns are at row-1 and row.
    const centre = offsetToAxial({ col: 4, row: 4 });
    const touching = [
      { col: 4, row: 3 }, // N
      { col: 4, row: 5 }, // S
      { col: 3, row: 3 }, // NW
      { col: 3, row: 4 }, // SW
      { col: 5, row: 3 }, // NE
      { col: 5, row: 4 }, // SE
    ];
    for (const offset of touching) {
      expect(distance(centre, offsetToAxial(offset))).toBe(1);
    }
  });

  it('makes offset-grid neighbours exactly one axial step apart (odd column)', () => {
    // Odd columns sit half a hex lower, which flips which rows they touch:
    // row and row+1 rather than row-1 and row. Getting this parity backwards is
    // the classic offset-grid bug, so both cases are pinned down.
    const centre = offsetToAxial({ col: 5, row: 4 });
    const touching = [
      { col: 5, row: 3 }, // N
      { col: 5, row: 5 }, // S
      { col: 4, row: 4 }, // NW
      { col: 4, row: 5 }, // SW
      { col: 6, row: 4 }, // NE
      { col: 6, row: 5 }, // SE
    ];
    for (const offset of touching) {
      expect(distance(centre, offsetToAxial(offset))).toBe(1);
    }
  });

  it('survives negative axial coordinates', () => {
    for (const hex of [{ q: -3, r: 2 }, { q: -2, r: -5 }, { q: -7, r: 4 }]) {
      expect(offsetToAxial(axialToOffset(hex))).toEqual(hex);
    }
  });
});

// --- tileAt -----------------------------------------------------------------

describe('tileAt', () => {
  it('matches a linear search for every tile on a generated map', () => {
    // Guards the O(1) index shortcut against generateMap's fill order changing.
    const map = generateMap();
    for (const expected of map.tiles) {
      const found = tileAt(map, { col: expected.col, row: expected.row });
      expect(found).toBe(
        map.tiles.find((t) => t.col === expected.col && t.row === expected.row),
      );
      expect(found).toBe(expected);
    }
  });

  it('returns undefined off the edges', () => {
    const map = makeMap(5, 5);
    for (const off of [
      { col: -1, row: 0 },
      { col: 0, row: -1 },
      { col: 5, row: 0 },
      { col: 0, row: 5 },
    ]) {
      expect(tileAt(map, off)).toBeUndefined();
    }
  });
});

// --- reachability -----------------------------------------------------------

describe('reachableHexes', () => {
  it('covers exactly the 19 hexes within 2 steps on open plains', () => {
    // 1 + 3n(n+1) for n=2 — the launcher's full budget with nothing in the way.
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const reached = reachableHexes(openField([unit]), unit);
    expect(reached.size).toBe(19);
  });

  it('reports cost 0 for its own hex, 1 for adjacent, 2 for two steps', () => {
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const reached = reachableHexes(openField([unit]), unit);
    for (const [key, entry] of reached) {
      expect(entry.cost).toBe(distance(CENTER, entry.hex));
      expect(key).toBe(hexKey(entry.hex));
    }
  });

  it('returns only the starting hex for an immobile unit', () => {
    const radar = makeUnit('r1', 'p1', 'radar', CENTER);
    const reached = reachableHexes(openField([radar]), radar);
    expect(reached.size).toBe(1);
    expect(reached.get(hexKey(CENTER))?.cost).toBe(0);
  });

  it('is trapped by a ring of mountains', () => {
    const map = makeMap(21, 21);
    for (const n of neighbors(CENTER)) setTerrain(map, n, 'mountain');
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const reached = reachableHexes(makeState(map, [unit]), unit);
    expect(reached.size).toBe(1);
  });

  it('is trapped by a ring of other units', () => {
    const map = makeMap(21, 21);
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const wall = neighbors(CENTER).map((hex, i) =>
      makeUnit(`w${i}`, 'p2', 'launcher', hex),
    );
    const reached = reachableHexes(makeState(map, [unit, ...wall]), unit);
    expect(reached.size).toBe(1);
  });

  it('ignores destroyed units when deciding what is blocked', () => {
    const map = makeMap(21, 21);
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const wall = neighbors(CENTER).map((hex, i) => {
      const dead = makeUnit(`w${i}`, 'p2', 'launcher', hex);
      dead.destroyed = true;
      return dead;
    });
    const reached = reachableHexes(makeState(map, [unit, ...wall]), unit);
    expect(reached.size).toBe(19);
  });

  it('cannot cut through a mountain even when the target is 2 steps away', () => {
    // THE case that proves distance() alone is the wrong check. The only hex
    // adjacent to both CENTER and `target` is `chokepoint`; block it and the
    // target needs 4 steps, well past the launcher's budget of 2 — even though
    // straight-line distance still says 2.
    const map = makeMap(21, 21);
    const target: Hex = { q: CENTER.q + 2, r: CENTER.r };
    const chokepoint: Hex = { q: CENTER.q + 1, r: CENTER.r };
    expect(distance(CENTER, target)).toBe(2);

    setTerrain(map, chokepoint, 'mountain');
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const reached = reachableHexes(makeState(map, [unit]), unit);

    expect(reached.has(hexKey(target))).toBe(false);
    expect(reached.has(hexKey(chokepoint))).toBe(false);
    expect(reached.size).toBe(19 - 2); // the mountain and the hex behind it
  });

  it('is clipped by the edge of the map', () => {
    const map = makeMap(21, 21);
    const corner = offsetToAxial({ col: 0, row: 0 });
    const unit = makeUnit('u1', 'p1', 'launcher', corner);
    const reached = reachableHexes(makeState(map, [unit]), unit);
    expect(reached.size).toBeLessThan(19);
    for (const { hex } of reached.values()) {
      expect(tileAt(map, axialToOffset(hex))).toBeDefined();
    }
  });
});

// --- validateMove: legal ----------------------------------------------------

describe('validateMove — legal moves', () => {
  it('allows a one-step move and reports its cost', () => {
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const target: Hex = { q: CENTER.q + 1, r: CENTER.r };
    const result = validateMove(openField([unit]), 'p1', move('u1', target));
    expect(result).toEqual({ legal: true, cost: 1 });
  });

  it('allows a full two-step move', () => {
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const target: Hex = { q: CENTER.q + 2, r: CENTER.r };
    const result = validateMove(openField([unit]), 'p1', move('u1', target));
    expect(result).toEqual({ legal: true, cost: 2 });
  });

  it('allows moving onto a hex a destroyed unit occupies', () => {
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const target: Hex = { q: CENTER.q + 1, r: CENTER.r };
    const corpse = makeUnit('u2', 'p2', 'launcher', target);
    corpse.destroyed = true;
    const result = validateMove(
      openField([unit, corpse]),
      'p1',
      move('u1', target),
    );
    expect(result).toEqual({ legal: true, cost: 1 });
  });

  it('routes around a mountain when a second path exists', () => {
    // {q+1, r+1} sits 2 steps away and has TWO valid one-step intermediates:
    // {q+1, r} and {q, r+1}. Blocking one must not make it unreachable — the
    // fill has to actually find the detour rather than give up on the direct
    // line. (Contrast the chokepoint case, where only one intermediate exists.)
    const map = makeMap(21, 21);
    const target: Hex = { q: CENTER.q + 1, r: CENTER.r + 1 };
    expect(distance(CENTER, target)).toBe(2);

    setTerrain(map, { q: CENTER.q + 1, r: CENTER.r }, 'mountain');
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    expect(validateMove(makeState(map, [unit]), 'p1', move('u1', target))).toEqual({
      legal: true,
      cost: 2,
    });
  });
});

// --- validateMove: every illegal reason -------------------------------------

describe('validateMove — illegal moves', () => {
  it('UNKNOWN_UNIT for an id that is not in the game', () => {
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const result = validateMove(
      openField([unit]),
      'p1',
      move('nope', { q: CENTER.q + 1, r: CENTER.r }),
    );
    expect(result).toEqual({ legal: false, reason: 'UNKNOWN_UNIT' });
  });

  it("NOT_YOUR_UNIT when ordering the opponent's launcher", () => {
    const enemy = makeUnit('u1', 'p2', 'launcher', CENTER);
    const result = validateMove(
      openField([enemy]),
      'p1',
      move('u1', { q: CENTER.q + 1, r: CENTER.r }),
    );
    expect(result).toEqual({ legal: false, reason: 'NOT_YOUR_UNIT' });
  });

  it('UNIT_DESTROYED for a dead launcher', () => {
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    unit.destroyed = true;
    const result = validateMove(
      openField([unit]),
      'p1',
      move('u1', { q: CENTER.q + 1, r: CENTER.r }),
    );
    expect(result).toEqual({ legal: false, reason: 'UNIT_DESTROYED' });
  });

  it.each(['radar', 'interceptor', 'leader'] as const)(
    'IMMOBILE_UNIT for %s',
    (kind) => {
      const unit = makeUnit('u1', 'p1', kind, CENTER);
      const result = validateMove(
        openField([unit]),
        'p1',
        move('u1', { q: CENTER.q + 1, r: CENTER.r }),
      );
      expect(result).toEqual({ legal: false, reason: 'IMMOBILE_UNIT' });
    },
  );

  it('SAME_HEX when the destination is where it already stands', () => {
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const result = validateMove(openField([unit]), 'p1', move('u1', CENTER));
    expect(result).toEqual({ legal: false, reason: 'SAME_HEX' });
  });

  it('OFF_MAP for a destination past the edge', () => {
    const unit = makeUnit('u1', 'p1', 'launcher', offsetToAxial({ col: 0, row: 0 }));
    const result = validateMove(
      openField([unit]),
      'p1',
      move('u1', offsetToAxial({ col: -1, row: 0 })),
    );
    expect(result).toEqual({ legal: false, reason: 'OFF_MAP' });
  });

  it('IMPASSABLE_TERRAIN for a mountain destination', () => {
    const map = makeMap(21, 21);
    const target: Hex = { q: CENTER.q + 1, r: CENTER.r };
    setTerrain(map, target, 'mountain');
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    expect(validateMove(makeState(map, [unit]), 'p1', move('u1', target))).toEqual({
      legal: false,
      reason: 'IMPASSABLE_TERRAIN',
    });
  });

  it.each(['p1', 'p2'] as const)(
    'TILE_OCCUPIED when a living %s unit is already there',
    (owner) => {
      const target: Hex = { q: CENTER.q + 1, r: CENTER.r };
      const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
      const blocker = makeUnit('u2', owner, 'launcher', target);
      const result = validateMove(
        openField([unit, blocker]),
        'p1',
        move('u1', target),
      );
      expect(result).toEqual({ legal: false, reason: 'TILE_OCCUPIED' });
    },
  );

  it('OUT_OF_RANGE for an open-plains hex 3 steps away', () => {
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const target: Hex = { q: CENTER.q + 3, r: CENTER.r };
    expect(distance(CENTER, target)).toBe(3);
    const result = validateMove(openField([unit]), 'p1', move('u1', target));
    expect(result).toEqual({ legal: false, reason: 'OUT_OF_RANGE' });
  });

  it('OUT_OF_RANGE when a mountain walls off a hex only 2 steps away', () => {
    // Same scenario as the reachability test, asserted through the public API:
    // the order looks legal by straight-line distance and is not.
    const map = makeMap(21, 21);
    const target: Hex = { q: CENTER.q + 2, r: CENTER.r };
    setTerrain(map, { q: CENTER.q + 1, r: CENTER.r }, 'mountain');
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    expect(distance(CENTER, target)).toBe(2);
    expect(validateMove(makeState(map, [unit]), 'p1', move('u1', target))).toEqual({
      legal: false,
      reason: 'OUT_OF_RANGE',
    });
  });
});
