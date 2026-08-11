import { describe, expect, it } from 'vitest';
import { UNIT_DEFS } from './defs';
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
  return {
    id,
    owner,
    kind,
    position,
    hp: UNIT_DEFS[kind].hp,
    destroyed: false,
  };
}

function makeState(map: MapData, units: Unit[]): GameState {
  return {
    round: 1,
    phase: 'ORDER_PHASE',
    map,
    units,
    intel: {
      p1: { staticReveals: [], contacts: [] },
      p2: { staticReveals: [], contacts: [] },
    },
    droneRespawnIn: { p1: 0, p2: 0 },
    deadHandFor: null,
    outcome: null,
  };
}

/**
 * The launcher's budget, read from the balance table rather than hardcoded.
 *
 * Every geometry assertion below is written in terms of this, so tuning
 * launcher movement in defs.ts stays the one-file diff CLAUDE.md's data-table
 * rule promises — it must not silently invalidate the movement tests.
 */
const BUDGET = UNIT_DEFS.launcher.movement;

/** Hexes within n steps of a hex on open ground: the standard 1 + 3n(n+1). */
function openReach(n: number): number {
  return 1 + 3 * n * (n + 1);
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
  it('covers exactly the hexes within its movement budget on open plains', () => {
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const reached = reachableHexes(openField([unit]), unit);
    expect(reached.size).toBe(openReach(BUDGET));
  });

  it("reports every hex's cost as its true distance from the start", () => {
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const reached = reachableHexes(openField([unit]), unit);
    for (const [key, entry] of reached) {
      expect(entry.cost).toBe(distance(CENTER, entry.hex));
      expect(key).toBe(hexKey(entry.hex));
    }
  });

  it('returns only the starting hex for an immobile unit', () => {
    const base = makeUnit('b1', 'p1', 'interceptor', CENTER);
    const reached = reachableHexes(openField([base]), base);
    expect(reached.size).toBe(1);
    expect(reached.get(hexKey(CENTER))?.cost).toBe(0);
  });

  it('returns only the starting hex for the drone, despite its move 6', () => {
    // The drone's UNIT_DEFS movement is a straight-line FLIGHT range (spec
    // §11), not a ground budget. Ground movement is launchers only (§9), so
    // this fill must refuse it rather than confidently flood 6 hexes out.
    expect(UNIT_DEFS.drone.movement).toBeGreaterThan(0);
    const drone = makeUnit('d1', 'p1', 'drone', CENTER);
    const reached = reachableHexes(openField([drone]), drone);
    expect(reached.size).toBe(1);
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
    expect(reached.size).toBe(openReach(BUDGET));
  });

  it('cannot cut through a mountain that blocks the only shortest path', () => {
    // THE case that proves distance() alone is the wrong check.
    //
    // A target straight out along the +q axis has exactly ONE shortest path —
    // every step in the same direction — so blocking its first hex forces a
    // detour costing BUDGET + 1. That holds for any budget, which is why this
    // test survives a balance change: straight-line distance still says the
    // target is exactly a full move away, and it is genuinely unreachable.
    const map = makeMap(21, 21);
    const target: Hex = { q: CENTER.q + BUDGET, r: CENTER.r };
    const chokepoint: Hex = { q: CENTER.q + 1, r: CENTER.r };
    expect(distance(CENTER, target)).toBe(BUDGET);

    setTerrain(map, chokepoint, 'mountain');
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const reached = reachableHexes(makeState(map, [unit]), unit);

    expect(reached.has(hexKey(target))).toBe(false);
    expect(reached.has(hexKey(chokepoint))).toBe(false);
    // ...while a hex the same distance away off the blocked axis still is
    // reachable, so this is the fill respecting cost, not giving up early.
    const detour: Hex = { q: CENTER.q + BUDGET, r: CENTER.r - 1 };
    expect(distance(CENTER, detour)).toBe(BUDGET);
    expect(reached.has(hexKey(detour))).toBe(true);
  });

  it('is clipped by the edge of the map', () => {
    const map = makeMap(21, 21);
    const corner = offsetToAxial({ col: 0, row: 0 });
    const unit = makeUnit('u1', 'p1', 'launcher', corner);
    const reached = reachableHexes(makeState(map, [unit]), unit);
    expect(reached.size).toBeLessThan(openReach(BUDGET));
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

  it('allows a move that spends the entire movement budget', () => {
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const target: Hex = { q: CENTER.q + BUDGET, r: CENTER.r };
    const result = validateMove(openField([unit]), 'p1', move('u1', target));
    expect(result).toEqual({ legal: true, cost: BUDGET });
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

  // All three static kinds, including the decoy — which must block and behave
  // exactly like the real bunker in every rule (spec §12).
  it.each(['interceptor', 'bunker', 'decoy'] as const)(
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

  it('AIR_UNIT when a MOVE order names the drone', () => {
    // The drone is not immobile — it moves 6 a round — but only by FLY along a
    // straight hexLine (spec §11). A MOVE order for it is a category error, so
    // it gets its own reason rather than the misleading IMMOBILE_UNIT.
    const drone = makeUnit('d1', 'p1', 'drone', CENTER);
    const result = validateMove(
      openField([drone]),
      'p1',
      move('d1', { q: CENTER.q + 1, r: CENTER.r }),
    );
    expect(result).toEqual({ legal: false, reason: 'AIR_UNIT' });
  });

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

  it('OUT_OF_RANGE for an open-plains hex one step past the budget', () => {
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    const target: Hex = { q: CENTER.q + BUDGET + 1, r: CENTER.r };
    expect(distance(CENTER, target)).toBe(BUDGET + 1);
    const result = validateMove(openField([unit]), 'p1', move('u1', target));
    expect(result).toEqual({ legal: false, reason: 'OUT_OF_RANGE' });
  });

  it('OUT_OF_RANGE when a mountain walls off a hex within straight-line range', () => {
    // Same scenario as the reachability test, asserted through the public API:
    // the order looks legal by straight-line distance and is not.
    const map = makeMap(21, 21);
    const target: Hex = { q: CENTER.q + BUDGET, r: CENTER.r };
    setTerrain(map, { q: CENTER.q + 1, r: CENTER.r }, 'mountain');
    const unit = makeUnit('u1', 'p1', 'launcher', CENTER);
    expect(distance(CENTER, target)).toBe(BUDGET);
    expect(validateMove(makeState(map, [unit]), 'p1', move('u1', target))).toEqual({
      legal: false,
      reason: 'OUT_OF_RANGE',
    });
  });
});
