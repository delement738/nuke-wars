// The forced-march rule, end to end (spec §9, §11 — added 2026-08-13).
//
// A dedicated file rather than rows in movement.test.ts and resolve.test.ts,
// because the rule is one idea spread over three modules: the budget lives in
// `movement.ts`, the reveal in `resolve.ts` phase 5, and the routing in
// `visibility.ts`. Splitting the tests by module would scatter a single rule
// across three files and make the load-bearing part — that the extra distance
// and the public reveal are the *same* decision — impossible to read in one go.
//
// The invariants worth naming, because each one is a mutation guard:
//
//   1. A march is a WALK on a bigger budget — same flood fill, so it is stopped
//      by mountains and units exactly as a move is. Turning it into a
//      `distance <= 6` check is the tempting optimisation and it is wrong.
//   2. The reveal fires on the ATTEMPT, not on arrival. A blocked march and a
//      standoff march are both heard.
//   3. `MARCH_DETECTED` carries the ORIGIN and never the destination.
//   4. The contact is filed against the marcher's OPPONENT (gotcha 21b).
//   5. `MARCH_DETECTED` is emitted in ascending ORIGIN HEX order, never in
//      `GameState.units` order — it is public, and units order would publish an
//      ordering of the marching launchers' ids (gotcha 22's leak, exactly).

import { describe, expect, it } from 'vitest';
import { RULES, UNIT_DEFS } from './defs';
import { axialToOffset, hexKey, offsetToAxial, type Hex } from './hex';
import { tileAt, type MapData, type Terrain, type TileData } from './map';
import { groundBudget, validateMarch, validateMove } from './movement';
import { resolve } from './resolve';
import type {
  GameEvent,
  GameState,
  MarchOrder,
  MoveOrder,
  Order,
  PlayerId,
  Unit,
  UnitId,
  UnitKind,
} from './types';
import { filterEventsForPlayer, filterForPlayer } from './visibility';

// --- fixtures ---------------------------------------------------------------
// Synthetic all-plains maps, same approach as movement.test.ts / resolve.test.ts:
// terrain is controlled rather than seed-dependent. Fill order must match
// generateMap's column-major order for tileAt's index math.

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

// Narrowed return types, not `Order` — `validateMarch` / `validateMove` take
// the specific variant, and a helper returning the wide union would only
// typecheck behind a cast.
function march(unitId: string, destination: Hex): MarchOrder {
  return { type: 'MARCH', unitId, destination };
}

function move(unitId: string, destination: Hex): MoveOrder {
  return { type: 'MOVE', unitId, destination };
}

/**
 * A living launcher parked in a far corner, out of every fixture's way.
 *
 * Same reason as `resolve.test.ts`'s `spare`: a side whose only launcher is a
 * corpse is a disarmament, and phase 4 would stop the round at the outcome check
 * before phase 5 ever ran (gotcha 28).
 */
function spare(owner: PlayerId): Unit {
  const corner = owner === 'p1' ? { col: 0, row: 20 } : { col: 20, row: 0 };
  return makeUnit(`${owner}-spare`, owner, 'launcher', offsetToAxial(corner));
}

/** A hex comfortably inside a 21x21 map, so edge clipping never interferes. */
const CENTER: Hex = offsetToAxial({ col: 10, row: 10 });

/** A hex exactly `steps` away, walking due north (up the board's long axis). */
function north(from: Hex, steps: number): Hex {
  const offset = axialToOffset(from);
  return offsetToAxial({ col: offset.col, row: offset.row - steps });
}

function openField(units: Unit[] = []): GameState {
  return makeState(makeMap(21, 21), units);
}

function positionOf(state: GameState, id: UnitId): Hex {
  const unit = state.units.find((u) => u.id === id);
  if (!unit) throw new Error(`no unit ${id}`);
  return unit.position;
}

/** Every MARCH_DETECTED in a log, in emission order. */
function marchEvents(events: readonly GameEvent[]) {
  return events.filter((e) => e.type === 'MARCH_DETECTED');
}

/** Both balance numbers, read from the table so a tuning pass moves the tests. */
const WALK = UNIT_DEFS.launcher.movement;
const MARCH = RULES.forcedMarchMovement;

// ---------------------------------------------------------------------------

describe('groundBudget (spec §9)', () => {
  it('is the launcher movement stat for MOVE and the march stat for MARCH', () => {
    const launcher = makeUnit('p1-l', 'p1', 'launcher', CENTER);

    expect(groundBudget(launcher, 'MOVE')).toBe(WALK);
    expect(groundBudget(launcher, 'MARCH')).toBe(MARCH);
  });

  it('gives a non-launcher its own stat, so no caller can hand a drone a ground budget', () => {
    const drone = makeUnit('p1-d', 'p1', 'drone', CENTER);
    const base = makeUnit('p1-i', 'p1', 'interceptor', CENTER);

    // The drone's number is a FLIGHT range and must never be raised by a march
    // (gotcha 10); a base is immobile and stays immobile.
    expect(groundBudget(drone, 'MARCH')).toBe(UNIT_DEFS.drone.movement);
    expect(groundBudget(base, 'MARCH')).toBe(0);
  });

  it('marches strictly further than it walks — the whole point of the order', () => {
    expect(MARCH).toBeGreaterThan(WALK);
  });
});

describe('validateMarch (spec §9)', () => {
  it('reaches a hex that MOVE rejects as out of range', () => {
    const launcher = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const state = openField([launcher]);
    const far = north(CENTER, MARCH);

    expect(validateMove(state, 'p1', move('p1-l', far))).toEqual({
      legal: false,
      reason: 'OUT_OF_RANGE',
    });
    expect(validateMarch(state, 'p1', march('p1-l', far))).toEqual({
      legal: true,
      cost: MARCH,
    });
  });

  it('still runs out of range one hex past the march budget', () => {
    const launcher = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const state = openField([launcher]);

    expect(
      validateMarch(state, 'p1', march('p1-l', north(CENTER, MARCH + 1))),
    ).toEqual({ legal: false, reason: 'OUT_OF_RANGE' });
  });

  it('is a flood fill, not a distance check — a mountain wall stops it dead', () => {
    // MUTATION GUARD. Replace the march budget with `distance(from, to) <= 6`
    // and this passes a launcher straight through a ridge. The destination here
    // is 2 hexes away in a straight line and unreachable at ANY budget, because
    // the whole ring around the launcher is mountain.
    const launcher = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const state = openField([launcher]);

    // Wall off every neighbour, leaving the launcher boxed in.
    const { col, row } = axialToOffset(CENTER);
    for (const d of [
      { col: col - 1, row: row - 1 },
      { col: col - 1, row },
      { col, row: row - 1 },
      { col, row: row + 1 },
      { col: col + 1, row: row - 1 },
      { col: col + 1, row },
      { col: col + 1, row: row + 1 },
      { col: col - 1, row: row + 1 },
    ]) {
      setTerrain(state.map, offsetToAxial(d), 'mountain');
    }

    expect(validateMarch(state, 'p1', march('p1-l', north(CENTER, 2)))).toEqual({
      legal: false,
      reason: 'OUT_OF_RANGE',
    });
  });

  it('is blocked by a living ground unit exactly as a move is', () => {
    const launcher = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const blocker = makeUnit('p2-l', 'p2', 'launcher', north(CENTER, MARCH));
    const state = openField([launcher, blocker]);

    expect(
      validateMarch(state, 'p1', march('p1-l', north(CENTER, MARCH))),
    ).toEqual({ legal: false, reason: 'TILE_OCCUPIED' });
  });

  it('may not end on a mountain, same as a move (spec §2)', () => {
    const launcher = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const state = openField([launcher]);
    setTerrain(state.map, north(CENTER, MARCH), 'mountain');

    expect(
      validateMarch(state, 'p1', march('p1-l', north(CENTER, MARCH))),
    ).toEqual({ legal: false, reason: 'IMPASSABLE_TERRAIN' });
  });

  it('accepts a SHORT march — paying the reveal for a walk is the feint, not a bug', () => {
    // Deliberately legal (see the note on validateMarch). Rejecting it would
    // delete the tactic of announcing a hex you are leaving to draw a
    // counter-battery volley into empty ground.
    const launcher = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const state = openField([launcher]);

    expect(
      validateMarch(state, 'p1', march('p1-l', north(CENTER, 1))),
    ).toMatchObject({ legal: true });
  });

  // --- illegal orders ------------------------------------------------------

  it('rejects a march naming the drone with AIR_UNIT (spec §11)', () => {
    const drone = makeUnit('p1-d', 'p1', 'drone', CENTER);
    const state = openField([drone]);

    expect(validateMarch(state, 'p1', march('p1-d', north(CENTER, 2)))).toEqual({
      legal: false,
      reason: 'AIR_UNIT',
    });
  });

  it('rejects a march naming the enemy, an unknown unit, a corpse and its own hex', () => {
    const mine = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const theirs = makeUnit('p2-l', 'p2', 'launcher', north(CENTER, 8));
    const dead = { ...makeUnit('p1-x', 'p1', 'launcher', north(CENTER, 3)), destroyed: true };
    const state = openField([mine, theirs, dead]);

    expect(validateMarch(state, 'p1', march('p2-l', CENTER))).toEqual({
      legal: false,
      reason: 'NOT_YOUR_UNIT',
    });
    expect(validateMarch(state, 'p1', march('nobody', CENTER))).toEqual({
      legal: false,
      reason: 'UNKNOWN_UNIT',
    });
    expect(validateMarch(state, 'p1', march('p1-x', north(CENTER, 4)))).toEqual({
      legal: false,
      reason: 'UNIT_DESTROYED',
    });
    expect(validateMarch(state, 'p1', march('p1-l', CENTER))).toEqual({
      legal: false,
      reason: 'SAME_HEX',
    });
  });

  it('refuses an immobile placed asset', () => {
    const base = makeUnit('p1-i', 'p1', 'interceptor', CENTER);
    const state = openField([base]);

    expect(validateMarch(state, 'p1', march('p1-i', north(CENTER, 2)))).toEqual({
      legal: false,
      reason: 'IMMOBILE_UNIT',
    });
  });
});

describe('the forced march in resolution (spec §9, §11)', () => {
  it('moves the launcher and announces the hex it left', () => {
    const launcher = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const state = openField([launcher, spare('p2')]);
    const destination = north(CENTER, MARCH);

    const { state: next, events } = resolve(
      state,
      [march('p1-l', destination)],
      [],
      1,
    );

    expect(positionOf(next, 'p1-l')).toEqual(destination);

    const heard = marchEvents(events);
    expect(heard).toEqual([
      { type: 'MARCH_DETECTED', owner: 'p1', origin: CENTER },
    ]);
    // The whole feature in one assertion: the enemy is told where it STARTED.
    expect(heard[0].origin).toEqual(CENTER);
    expect(heard[0]).not.toHaveProperty('destination');
  });

  it('files the contact on the OPPONENT’s map, sourced MARCH', () => {
    // MUTATION GUARD for gotcha 21b: file this against the marcher instead and
    // each player gets a map of their own marches while the enemy's stay hidden.
    const launcher = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const state = openField([launcher, spare('p2')]);

    const { state: next } = resolve(
      state,
      [march('p1-l', north(CENTER, MARCH))],
      [],
      1,
    );

    expect(next.intel.p2.contacts).toEqual([{ hex: CENTER, source: 'MARCH' }]);
    expect(next.intel.p1.contacts).toEqual([]);
  });

  it('reveals on the ATTEMPT — a blocked march is heard and does not move', () => {
    const launcher = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const destination = north(CENTER, MARCH);
    const blocker = makeUnit('p2-l', 'p2', 'launcher', destination);
    const state = openField([launcher, blocker, spare('p2')]);

    const { state: next, events } = resolve(
      state,
      [march('p1-l', destination)],
      [],
      1,
    );

    expect(positionOf(next, 'p1-l')).toEqual(CENTER); // held — no partial advance
    expect(marchEvents(events)).toHaveLength(1);
    expect(
      events.some((e) => e.type === 'MOVE_FAILED' && e.unitId === 'p1-l'),
    ).toBe(true);
    expect(next.intel.p2.contacts).toEqual([{ hex: CENTER, source: 'MARCH' }]);
  });

  it('reveals a march that lost a standoff (spec §9)', () => {
    // Both claim the same hex, so neither moves — but the engines still started.
    const contested = north(CENTER, 3);
    const mine = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const theirs = makeUnit('p2-l', 'p2', 'launcher', north(contested, -3));
    const state = openField([mine, theirs, spare('p1'), spare('p2')]);

    const { state: next, events } = resolve(
      state,
      [march('p1-l', contested)],
      [move('p2-l', contested)],
      1,
    );

    expect(positionOf(next, 'p1-l')).toEqual(CENTER);
    expect(marchEvents(events)).toEqual([
      { type: 'MARCH_DETECTED', owner: 'p1', origin: CENTER },
    ]);
  });

  it('says nothing when the march is dropped for a reason the player could already see', () => {
    // A mountain destination is public information (§11), so the order is a
    // client bug rather than gameplay: dropped in silence, exactly as the
    // equivalent MOVE is, and heard by nobody.
    const launcher = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const state = openField([launcher, spare('p2')]);
    const destination = north(CENTER, MARCH);
    setTerrain(state.map, destination, 'mountain');

    const { state: next, events } = resolve(
      state,
      [march('p1-l', destination)],
      [],
      1,
    );

    expect(marchEvents(events)).toEqual([]);
    expect(next.intel.p2.contacts).toEqual([]);
    expect(
      events.some((e) => e.type === 'MOVE_FAILED' && e.unitId === 'p1-l'),
    ).toBe(false);
  });

  it('emits MARCH_DETECTED in ascending ORIGIN HEX order, not units order', () => {
    // MUTATION GUARD, and the most important test in this file. MARCH_DETECTED
    // is PUBLIC, so emitting in `GameState.units` order would publish the
    // relative unit ids of the marching launchers and let the enemy track a
    // specific launcher across rounds — the identity §11 keys all intel by hex
    // to withhold, and gotcha 22's leak exactly.
    //
    // The fixture puts the units in the array in the OPPOSITE order to their
    // hexes, so units order and hex order genuinely disagree.
    const west = offsetToAxial({ col: 4, row: 10 });
    const east = offsetToAxial({ col: 14, row: 10 });

    const first = makeUnit('p1-launcher-1', 'p1', 'launcher', east);
    const second = makeUnit('p1-launcher-2', 'p1', 'launcher', west);
    const state = openField([first, second, spare('p2')]);

    const { events } = resolve(
      state,
      [march('p1-launcher-1', north(east, 4)), march('p1-launcher-2', north(west, 4))],
      [],
      1,
    );

    const origins = marchEvents(events).map((e) => e.origin);
    expect(origins).toEqual([west, east]); // hex order
    expect(origins).not.toEqual([east, west]); // NOT units order
  });

  it('expires after exactly one round, like every launcher sighting (spec §11 rule 3)', () => {
    const launcher = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const state = openField([launcher, spare('p1'), spare('p2')]);

    const round1 = resolve(state, [march('p1-l', north(CENTER, MARCH))], [], 1);
    expect(round1.state.intel.p2.contacts).toHaveLength(1);

    // A quiet round: contacts are rebuilt from scratch in phase 1, so the march
    // marker is gone rather than expired by bookkeeping (gotcha 8).
    const round2 = resolve(round1.state, [], [], 1);
    expect(round2.state.intel.p2.contacts).toEqual([]);
  });

  it('does nothing and says nothing when the launcher is over budget', () => {
    // A launcher handed a MARCH *and* a LAUNCH has two orders, is over budget,
    // and does nothing at all — including going loud (gotcha 15).
    const launcher = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const state = openField([launcher, spare('p2')]);

    const { state: next, events } = resolve(
      state,
      [
        march('p1-l', north(CENTER, MARCH)),
        { type: 'LAUNCH', unitId: 'p1-l', target: north(CENTER, 4) },
      ],
      [],
      1,
    );

    expect(positionOf(next, 'p1-l')).toEqual(CENTER);
    expect(marchEvents(events)).toEqual([]);
    expect(next.intel.p2.contacts).toEqual([]);
  });

  it('resolves identically twice — determinism (spec §6)', () => {
    const build = () =>
      openField([
        makeUnit('p1-launcher-1', 'p1', 'launcher', offsetToAxial({ col: 4, row: 10 })),
        makeUnit('p1-launcher-2', 'p1', 'launcher', offsetToAxial({ col: 14, row: 10 })),
        makeUnit('p2-launcher-1', 'p2', 'launcher', offsetToAxial({ col: 9, row: 4 })),
      ]);

    const orders: Order[] = [
      march('p1-launcher-2', offsetToAxial({ col: 14, row: 6 })),
      march('p1-launcher-1', offsetToAxial({ col: 4, row: 6 })),
    ];

    const a = resolve(build(), orders, [march('p2-launcher-1', offsetToAxial({ col: 9, row: 8 }))], 1);
    const b = resolve(build(), orders, [march('p2-launcher-1', offsetToAxial({ col: 9, row: 8 }))], 1);

    expect(a.events).toEqual(b.events);
    expect(a.state.units).toEqual(b.state.units);
    expect(a.state.intel).toEqual(b.state.intel);
  });
});

describe('the forced march through the visibility filter (spec §6)', () => {
  it('reaches BOTH players — a loud action is heard by everybody', () => {
    const launcher = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const state = openField([launcher, spare('p2')]);

    const { events } = resolve(state, [march('p1-l', north(CENTER, MARCH))], [], 1);

    for (const player of ['p1', 'p2'] as const) {
      expect(
        marchEvents(filterEventsForPlayer(events, player)),
      ).toEqual([{ type: 'MARCH_DETECTED', owner: 'p1', origin: CENTER }]);
    }
  });

  it('puts the contact on the enemy’s filtered board and never on the marcher’s', () => {
    const launcher = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const state = openField([launcher, spare('p2')]);

    const { state: next } = resolve(
      state,
      [march('p1-l', north(CENTER, MARCH))],
      [],
      1,
    );

    expect(filterForPlayer(next, 'p2').intel.contacts).toEqual([
      { hex: CENTER, source: 'MARCH' },
    ]);
    expect(filterForPlayer(next, 'p1').intel.contacts).toEqual([]);
  });

  it('leaks no destination — the marcher’s new hex is absent from the enemy’s whole view', () => {
    // The enemy's filtered state holds only their own units (gotcha 31), so the
    // only thing that could carry the marcher's new position is the log. This
    // asserts it does not: the destination hex appears nowhere in p2's events.
    const launcher = makeUnit('p1-l', 'p1', 'launcher', CENTER);
    const state = openField([launcher, spare('p2')]);
    const destination = north(CENTER, MARCH);

    const { events } = resolve(state, [march('p1-l', destination)], [], 1);
    const seen = JSON.stringify(filterEventsForPlayer(events, 'p2'));

    expect(seen).toContain(JSON.stringify(CENTER));
    expect(seen).not.toContain(JSON.stringify(destination));
  });
});
