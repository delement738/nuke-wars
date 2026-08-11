import { describe, expect, it } from 'vitest';
import { isCoveredByEnemy } from './coverage';
import { RULES, UNIT_DEFS } from './defs';
import {
  axialToOffset,
  distance,
  hexKey,
  hexLine,
  neighbors,
  offsetToAxial,
  type Hex,
} from './hex';
import { tileAt, type MapData, type Terrain, type TileData } from './map';
import { droneFor, flyDrone, reconSwath, validateFly } from './recon';
import type { FlyOrder, GameState, PlayerId, Unit, UnitKind } from './types';

// --- fixtures ---------------------------------------------------------------
//
// Same approach as movement.test.ts and resolve.test.ts: synthetic all-plains
// maps rather than generateMap(), so terrain is controlled rather than
// seed-dependent. The fill order must match generateMap's column-major order
// for tileAt's index math to hold.

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
  return { id, owner, kind, position, hp: UNIT_DEFS[kind].hp, destroyed: false };
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

function openField(units: Unit[] = []): GameState {
  return makeState(makeMap(21, 21), units);
}

function fly(unitId: string, destination: Hex): FlyOrder {
  return { type: 'FLY', unitId, destination };
}

/** A hex comfortably inside a 21x21 map, so edge clipping never interferes. */
const CENTER: Hex = offsetToAxial({ col: 10, row: 10 });

/** The drone's flight range, read from the balance table rather than hardcoded. */
const FLIGHT = UNIT_DEFS.drone.movement;

/** A hex exactly `steps` away, walking due north (up the board's long axis). */
function north(from: Hex, steps: number): Hex {
  return offsetToAxial({
    col: axialToOffset(from).col,
    row: axialToOffset(from).row - steps,
  });
}

// --- interceptor coverage (spec §10) ----------------------------------------

describe('isCoveredByEnemy()', () => {
  const base = makeUnit('base', 'p2', 'interceptor', CENTER);

  it('covers the base hex itself and all six neighbours', () => {
    for (const hex of [CENTER, ...neighbors(CENTER)]) {
      expect(isCoveredByEnemy([base], hex, 'p1')).toBe(true);
    }
  });

  it('covers exactly radius 1 — nothing further out', () => {
    // Guard the premise: a radius change in defs.ts should fail here loudly.
    expect(RULES.interceptorCoverageRadius).toBe(1);
    const twoOut = north(CENTER, 2);
    expect(distance(CENTER, twoOut)).toBe(2);
    expect(isCoveredByEnemy([base], twoOut, 'p1')).toBe(false);
  });

  it('never engages for the base owner — friendly fire is impossible by signature', () => {
    // §10: friendly missiles and the owner's own drone are never engaged. The
    // viewer parameter is the whole guarantee.
    expect(isCoveredByEnemy([base], CENTER, 'p2')).toBe(false);
  });

  it('a destroyed base leaves no bubble behind', () => {
    const dead = { ...base, destroyed: true };
    expect(isCoveredByEnemy([dead], CENTER, 'p1')).toBe(false);
  });

  it('only interceptor bases cover anything', () => {
    const others: UnitKind[] = ['launcher', 'bunker', 'decoy', 'drone'];
    for (const kind of others) {
      const unit = makeUnit('x', 'p2', kind, CENTER);
      expect(isCoveredByEnemy([unit], CENTER, 'p1')).toBe(false);
    }
  });
});

// --- FLY order validation (spec §11) ----------------------------------------

describe('validateFly()', () => {
  it('accepts a flight inside range and reports the distance flown', () => {
    const destination = north(CENTER, 4);
    const state = openField([makeUnit('eye', 'p1', 'drone', CENTER)]);

    expect(validateFly(state, 'p1', fly('eye', destination))).toEqual({
      legal: true,
      distance: 4,
    });
  });

  it('accepts a flight of exactly the drone’s range and rejects one hex more', () => {
    const state = openField([makeUnit('eye', 'p1', 'drone', CENTER)]);

    expect(validateFly(state, 'p1', fly('eye', north(CENTER, FLIGHT))).legal).toBe(
      true,
    );
    expect(validateFly(state, 'p1', fly('eye', north(CENTER, FLIGHT + 1)))).toEqual({
      legal: false,
      reason: 'OUT_OF_RANGE',
    });
  });

  it('ignores terrain entirely — a mountain is nothing to an aircraft', () => {
    const destination = north(CENTER, 3);
    const state = openField([makeUnit('eye', 'p1', 'drone', CENTER)]);
    setTerrain(state.map, destination, 'mountain');

    expect(validateFly(state, 'p1', fly('eye', destination)).legal).toBe(true);
  });

  it('ignores occupancy — the drone neither blocks nor is blocked', () => {
    const destination = north(CENTER, 3);
    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('z', 'p2', 'launcher', destination),
    ]);

    expect(validateFly(state, 'p1', fly('eye', destination)).legal).toBe(true);
  });

  it('rejects flying to its own hex — "give no order to hover"', () => {
    const state = openField([makeUnit('eye', 'p1', 'drone', CENTER)]);

    expect(validateFly(state, 'p1', fly('eye', CENTER))).toEqual({
      legal: false,
      reason: 'SAME_HEX',
    });
  });

  it('rejects a destination off the board', () => {
    const state = openField([makeUnit('eye', 'p1', 'drone', CENTER)]);

    expect(
      validateFly(state, 'p1', fly('eye', offsetToAxial({ col: -3, row: 10 }))),
    ).toEqual({ legal: false, reason: 'OFF_MAP' });
  });

  it('rejects a FLY naming a launcher — only the drone flies', () => {
    const state = openField([makeUnit('a', 'p1', 'launcher', CENTER)]);

    expect(validateFly(state, 'p1', fly('a', north(CENTER, 2)))).toEqual({
      legal: false,
      reason: 'NOT_AIR_UNIT',
    });
  });

  it('rejects a downed drone still awaiting respawn', () => {
    const drone = makeUnit('eye', 'p1', 'drone', CENTER);
    drone.destroyed = true;
    const state = openField([drone]);

    expect(validateFly(state, 'p1', fly('eye', north(CENTER, 2)))).toEqual({
      legal: false,
      reason: 'UNIT_DESTROYED',
    });
  });

  it('rejects an order naming the enemy’s drone', () => {
    const state = openField([makeUnit('eye', 'p2', 'drone', CENTER)]);

    expect(validateFly(state, 'p1', fly('eye', north(CENTER, 2)))).toEqual({
      legal: false,
      reason: 'NOT_YOUR_UNIT',
    });
  });

  it('rejects an order naming a unit that does not exist', () => {
    const state = openField([makeUnit('eye', 'p1', 'drone', CENTER)]);

    expect(validateFly(state, 'p1', fly('ghost', north(CENTER, 2)))).toEqual({
      legal: false,
      reason: 'UNKNOWN_UNIT',
    });
  });
});

// --- flight resolution (spec §10) -------------------------------------------

describe('flyDrone()', () => {
  const drone = makeUnit('eye', 'p1', 'drone', CENTER);

  it('flies the whole hexLine when nothing threatens it', () => {
    const destination = north(CENTER, FLIGHT);

    const flight = flyDrone([drone], drone, destination);

    expect(flight.path).toEqual(hexLine(CENTER, destination));
    expect(flight.downedAt).toBeNull();
  });

  it('hovering resolves as a zero-length flight over its own hex', () => {
    const flight = flyDrone([drone], drone, CENTER);

    expect(flight.path).toEqual([CENTER]);
    expect(flight.downedAt).toBeNull();
  });

  it('dies on entering enemy coverage, transmitting everything up to that hex', () => {
    const destination = north(CENTER, FLIGHT);
    const line = hexLine(CENTER, destination);
    const base = makeUnit('base', 'p2', 'interceptor', line[3]);

    const flight = flyDrone([drone, base], drone, destination);

    // Killed entering line[2] — the first hex inside the base's radius-1 bubble.
    expect(flight.downedAt).toEqual(line[2]);
    expect(flight.path).toEqual([line[0], line[1]]);
  });

  it('keeps its start hex even when downed on the very first step', () => {
    const destination = north(CENTER, FLIGHT);
    const line = hexLine(CENTER, destination);
    const base = makeUnit('base', 'p2', 'interceptor', line[1]);

    const flight = flyDrone([drone, base], drone, destination);

    // Intel is transmitted live, not recovered from the wreck: the swath around
    // the hex it took off from still counts.
    expect(flight.downedAt).toEqual(line[1]);
    expect(flight.path).toEqual([CENTER]);
  });

  it('flies straight through its owner’s own coverage unharmed', () => {
    const destination = north(CENTER, FLIGHT);
    const line = hexLine(CENTER, destination);
    const friendly = makeUnit('base', 'p1', 'interceptor', line[3]);

    const flight = flyDrone([drone, friendly], drone, destination);

    expect(flight.downedAt).toBeNull();
    expect(flight.path).toEqual(line);
  });

  it('is not threatened by a destroyed enemy base', () => {
    const destination = north(CENTER, FLIGHT);
    const line = hexLine(CENTER, destination);
    const dead = makeUnit('base', 'p2', 'interceptor', line[3]);
    dead.destroyed = true;

    expect(flyDrone([drone, dead], drone, destination).downedAt).toBeNull();
  });

  it('never checks its origin — coverage kills on entry only', () => {
    // A base directly under a hovering drone cannot touch it. The state is
    // unreachable in a real match (the drone would have died entering that hex),
    // but the entry-only rule is what guarantees hovering is always safe.
    const base = makeUnit('base', 'p2', 'interceptor', CENTER);

    const flight = flyDrone([drone, base], drone, CENTER);

    expect(flight.downedAt).toBeNull();
    expect(flight.path).toEqual([CENTER]);
  });
});

// --- the reveal swath (spec §11) --------------------------------------------

describe('reconSwath()', () => {
  it('is a hex plus its six neighbours — 7 hexes for a hovering drone', () => {
    const swath = reconSwath([CENTER]);

    expect(swath.size).toBe(7);
    for (const hex of [CENTER, ...neighbors(CENTER)]) {
      expect(swath.has(hexKey(hex))).toBe(true);
    }
  });

  it('is 3 wide along the whole path, de-duplicated where corridors overlap', () => {
    const step = neighbors(CENTER)[0];
    const swath = reconSwath([CENTER, step]);

    // Two adjacent hexes share two common neighbours, and each is a neighbour of
    // the other: 7 + 7 with 4 overlaps = 10, not 14.
    expect(swath.size).toBe(10);
    for (const hex of [CENTER, step, ...neighbors(CENTER), ...neighbors(step)]) {
      expect(swath.has(hexKey(hex))).toBe(true);
    }
  });

  it('covers every hex of a full-length flight', () => {
    const line = hexLine(CENTER, north(CENTER, FLIGHT));
    const swath = reconSwath(line);

    for (const hex of line) expect(swath.has(hexKey(hex))).toBe(true);
  });

  it('reveals nothing at all for an empty path', () => {
    expect(reconSwath([]).size).toBe(0);
  });
});

// --- unit lookup ------------------------------------------------------------

describe('droneFor()', () => {
  it('finds a player’s drone, and still finds it once it is downed', () => {
    const alive = makeUnit('eye', 'p1', 'drone', CENTER);
    const downed = makeUnit('spy', 'p2', 'drone', north(CENTER, 5));
    downed.destroyed = true;
    const units = [makeUnit('a', 'p1', 'launcher', CENTER), alive, downed];

    // The respawn needs the destroyed one — same unit, revived in place.
    expect(droneFor(units, 'p1')).toBe(alive);
    expect(droneFor(units, 'p2')).toBe(downed);
  });

  it('returns undefined for a player with no drone unit', () => {
    expect(droneFor([makeUnit('a', 'p1', 'launcher', CENTER)], 'p2')).toBeUndefined();
  });
});
