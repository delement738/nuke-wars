import { describe, expect, it } from 'vitest';
import { UNIT_DEFS } from './defs';
import { axialToOffset, hexKey, neighbors, offsetToAxial, type Hex } from './hex';
import { tileAt, type MapData, type Terrain, type TileData } from './map';
import { resolve } from './resolve';
import type {
  GameEvent,
  GameState,
  Order,
  PlayerId,
  Unit,
  UnitId,
  UnitKind,
} from './types';

// --- fixtures ---------------------------------------------------------------
//
// Same approach as movement.test.ts: synthetic all-plains maps rather than
// generateMap(), so terrain is controlled rather than seed-dependent. The fill
// order must match generateMap's column-major order for tileAt's index math.

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

function move(unitId: string, destination: Hex): Order {
  return { type: 'MOVE', unitId, destination };
}

function launch(unitId: string, target: Hex): Order {
  return { type: 'LAUNCH', unitId, target };
}

/** A hex comfortably inside a 21x21 map, so edge clipping never interferes. */
const CENTER: Hex = offsetToAxial({ col: 10, row: 10 });

function openField(units: Unit[] = []): GameState {
  return makeState(makeMap(21, 21), units);
}

/** Position of a unit in a resolved state, by id. */
function positionOf(state: GameState, id: UnitId): Hex {
  const unit = state.units.find((u) => u.id === id);
  if (!unit) throw new Error(`no unit ${id}`);
  return unit.position;
}

function eventsFor(events: GameEvent[], id: UnitId): GameEvent[] {
  return events.filter((e) => 'unitId' in e && e.unitId === id);
}

const NO_ORDERS: Order[] = [];

// --- the happy path ---------------------------------------------------------

describe('resolve() — ground movement', () => {
  it('applies a legal move and emits UNIT_MOVED with both endpoints', () => {
    const to = neighbors(CENTER)[0];
    const state = openField([makeUnit('a', 'p1', 'launcher', CENTER)]);

    const result = resolve(state, [move('a', to)], NO_ORDERS, 0);

    expect(positionOf(result.state, 'a')).toEqual(to);
    expect(result.events).toEqual([
      { type: 'UNIT_MOVED', unitId: 'a', from: CENTER, to },
    ]);
  });

  it('leaves an un-ordered launcher in place and silent', () => {
    const state = openField([makeUnit('a', 'p1', 'launcher', CENTER)]);

    const result = resolve(state, NO_ORDERS, NO_ORDERS, 0);

    expect(positionOf(result.state, 'a')).toEqual(CENTER);
    expect(result.events).toEqual([]);
  });

  it('moves both players in the same round', () => {
    const p1To = neighbors(CENTER)[0];
    const enemyStart = offsetToAxial({ col: 4, row: 4 });
    const p2To = neighbors(enemyStart)[0];
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('z', 'p2', 'launcher', enemyStart),
    ]);

    const result = resolve(state, [move('a', p1To)], [move('z', p2To)], 0);

    expect(positionOf(result.state, 'a')).toEqual(p1To);
    expect(positionOf(result.state, 'z')).toEqual(p2To);
  });
});

// --- spec §9's five rulings -------------------------------------------------

describe('resolve() — §9 simultaneous-movement rulings', () => {
  it('standoff: two units ordered into the same empty hex, neither moves', () => {
    const [from1, from2] = [neighbors(CENTER)[0], neighbors(CENTER)[3]];
    const state = openField([
      makeUnit('a', 'p1', 'launcher', from1),
      makeUnit('z', 'p2', 'launcher', from2),
    ]);

    const result = resolve(state, [move('a', CENTER)], [move('z', CENTER)], 0);

    expect(positionOf(result.state, 'a')).toEqual(from1);
    expect(positionOf(result.state, 'z')).toEqual(from2);
    expect(result.events).toEqual([
      { type: 'MOVE_FAILED', unitId: 'a' },
      { type: 'MOVE_FAILED', unitId: 'z' },
    ]);
  });

  it('standoff holds for three or more claimants', () => {
    const n = neighbors(CENTER);
    const state = openField([
      makeUnit('a', 'p1', 'launcher', n[0]),
      makeUnit('b', 'p1', 'launcher', n[2]),
      makeUnit('z', 'p2', 'launcher', n[4]),
    ]);

    const result = resolve(
      state,
      [move('a', CENTER), move('b', CENTER)],
      [move('z', CENTER)],
      0,
    );

    expect(positionOf(result.state, 'a')).toEqual(n[0]);
    expect(positionOf(result.state, 'b')).toEqual(n[2]);
    expect(positionOf(result.state, 'z')).toEqual(n[4]);
    expect(result.events.every((e) => e.type === 'MOVE_FAILED')).toBe(true);
    expect(result.events).toHaveLength(3);
  });

  it('swap: two units ordered onto each other, both orders fail', () => {
    const b = neighbors(CENTER)[0];
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('z', 'p2', 'launcher', b),
    ]);

    const result = resolve(state, [move('a', b)], [move('z', CENTER)], 0);

    expect(positionOf(result.state, 'a')).toEqual(CENTER);
    expect(positionOf(result.state, 'z')).toEqual(b);
    expect(eventsFor(result.events, 'a')).toEqual([
      { type: 'MOVE_FAILED', unitId: 'a' },
    ]);
    expect(eventsFor(result.events, 'z')).toEqual([
      { type: 'MOVE_FAILED', unitId: 'z' },
    ]);
  });

  it('no chaining: following a unit into the hex it vacates is illegal', () => {
    const mid = neighbors(CENTER)[0];
    const ahead = neighbors(mid)[0];
    // Guard the geometry the ruling depends on: 'a' really is stepping away
    // from 'b', into a hex nobody else claims.
    expect(hexKey(ahead)).not.toBe(hexKey(CENTER));

    const state = openField([
      makeUnit('a', 'p1', 'launcher', mid),
      makeUnit('b', 'p1', 'launcher', CENTER),
    ]);

    const result = resolve(state, [move('a', ahead), move('b', mid)], NO_ORDERS, 0);

    // 'a' vacates mid successfully; 'b' may NOT follow, because occupancy is
    // judged at phase start. Permitting it would make resolution order-dependent.
    expect(positionOf(result.state, 'a')).toEqual(ahead);
    expect(positionOf(result.state, 'b')).toEqual(CENTER);
    expect(eventsFor(result.events, 'b')).toEqual([
      { type: 'MOVE_FAILED', unitId: 'b' },
    ]);
  });

  it('blocked by an undetected enemy: order fails entirely, no partial advance', () => {
    const blocked = neighbors(CENTER)[0];
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('z', 'p2', 'launcher', blocked),
    ]);

    const result = resolve(state, [move('a', blocked)], NO_ORDERS, 0);

    expect(positionOf(result.state, 'a')).toEqual(CENTER);
    expect(eventsFor(result.events, 'a')).toEqual([
      { type: 'MOVE_FAILED', unitId: 'a' },
    ]);
  });

  it('a decoy blocks movement exactly like any ground unit (§12)', () => {
    const blocked = neighbors(CENTER)[0];
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('fake', 'p2', 'decoy', blocked),
    ]);

    const result = resolve(state, [move('a', blocked)], NO_ORDERS, 0);

    // If the decoy were passable, walking a launcher through a suspected site
    // would identify the fake for free.
    expect(positionOf(result.state, 'a')).toEqual(CENTER);
    expect(eventsFor(result.events, 'a')).toEqual([
      { type: 'MOVE_FAILED', unitId: 'a' },
    ]);
  });

  it('a destroyed unit blocks nothing', () => {
    const target = neighbors(CENTER)[0];
    const corpse = makeUnit('z', 'p2', 'launcher', target);
    corpse.destroyed = true;
    const state = openField([makeUnit('a', 'p1', 'launcher', CENTER), corpse]);

    const result = resolve(state, [move('a', target)], NO_ORDERS, 0);

    expect(positionOf(result.state, 'a')).toEqual(target);
  });
});

// --- MOVE_FAILED policy: hidden-info failures only --------------------------

describe('resolve() — which failures are reported', () => {
  it('reports OUT_OF_RANGE when an unseen enemy seals the only exit', () => {
    const state = openField([makeUnit('a', 'p1', 'launcher', CENTER)]);
    const ring = neighbors(CENTER);
    const exit = ring[0];
    // Wall the launcher in, leaving exactly one plains exit.
    for (const hex of ring.slice(1)) setTerrain(state.map, hex, 'mountain');
    const destination = neighbors(exit).find(
      (h) => hexKey(h) !== hexKey(CENTER) && !ring.some((r) => hexKey(r) === hexKey(h)),
    )!;

    // Sanity: with the exit clear, the move is legal.
    const clear = resolve(state, [move('a', destination)], NO_ORDERS, 0);
    expect(positionOf(clear.state, 'a')).toEqual(destination);

    // Now plug the exit with an enemy the player cannot see.
    state.units.push(makeUnit('z', 'p2', 'launcher', exit));
    const sealed = resolve(state, [move('a', destination)], NO_ORDERS, 0);

    expect(positionOf(sealed.state, 'a')).toEqual(CENTER);
    expect(eventsFor(sealed.events, 'a')).toEqual([
      { type: 'MOVE_FAILED', unitId: 'a' },
    ]);
  });

  it.each([
    ['IMPASSABLE_TERRAIN', 'mountain destination'],
    ['SAME_HEX', 'ordering a unit onto its own hex'],
    ['OFF_MAP', 'destination off the board'],
  ])('drops %s silently — public information, so a client bug (%s)', (reason) => {
    const state = openField([makeUnit('a', 'p1', 'launcher', CENTER)]);

    let destination: Hex;
    if (reason === 'IMPASSABLE_TERRAIN') {
      destination = neighbors(CENTER)[0];
      setTerrain(state.map, destination, 'mountain');
    } else if (reason === 'SAME_HEX') {
      destination = CENTER;
    } else {
      destination = offsetToAxial({ col: -5, row: -5 });
    }

    const result = resolve(state, [move('a', destination)], NO_ORDERS, 0);

    expect(positionOf(result.state, 'a')).toEqual(CENTER);
    expect(result.events).toEqual([]);
  });

  it('drops a MOVE naming the drone (AIR_UNIT) — it flies, never marches', () => {
    const state = openField([makeUnit('eye', 'p1', 'drone', CENTER)]);

    const result = resolve(state, [move('eye', neighbors(CENTER)[0])], NO_ORDERS, 0);

    expect(positionOf(result.state, 'eye')).toEqual(CENTER);
    expect(result.events).toEqual([]);
  });

  it('drops a MOVE naming an immobile asset', () => {
    const state = openField([makeUnit('base', 'p1', 'interceptor', CENTER)]);

    const result = resolve(state, [move('base', neighbors(CENTER)[0])], NO_ORDERS, 0);

    expect(result.events).toEqual([]);
  });

  it('never emits an event for an order naming an ENEMY unit — that would leak', () => {
    const enemyHex = offsetToAxial({ col: 4, row: 4 });
    const state = openField([makeUnit('z', 'p2', 'launcher', enemyHex)]);

    // p1 tries to order p2's launcher, and tries a hex p2 could legally reach.
    const result = resolve(state, [move('z', neighbors(enemyHex)[0])], NO_ORDERS, 0);

    expect(positionOf(result.state, 'z')).toEqual(enemyHex);
    // A MOVE_FAILED here would put a real enemy unit id into p1's log.
    expect(result.events).toEqual([]);
  });

  it('drops an order naming a unit that does not exist', () => {
    const state = openField([makeUnit('a', 'p1', 'launcher', CENTER)]);

    const result = resolve(state, [move('ghost', CENTER)], NO_ORDERS, 0);

    expect(result.events).toEqual([]);
  });

  it('drops an order naming an already-destroyed unit', () => {
    const dead = makeUnit('a', 'p1', 'launcher', CENTER);
    dead.destroyed = true;
    const state = openField([dead]);

    const result = resolve(state, [move('a', neighbors(CENTER)[0])], NO_ORDERS, 0);

    expect(positionOf(result.state, 'a')).toEqual(CENTER);
    expect(result.events).toEqual([]);
  });
});

// --- one order per unit (RULES.ordersPerUnit) -------------------------------

describe('resolve() — one order per unit', () => {
  it('a unit given two MOVE orders holds position and emits nothing', () => {
    const n = neighbors(CENTER);
    const state = openField([makeUnit('a', 'p1', 'launcher', CENTER)]);

    const result = resolve(state, [move('a', n[0]), move('a', n[1])], NO_ORDERS, 0);

    // The engine never guesses which order was meant.
    expect(positionOf(result.state, 'a')).toEqual(CENTER);
    expect(result.events).toEqual([]);
  });

  it('MOVE + LAUNCH for one unit is over budget — move-XOR-launch is structural', () => {
    const to = neighbors(CENTER)[0];
    const state = openField([makeUnit('a', 'p1', 'launcher', CENTER)]);

    const result = resolve(
      state,
      [move('a', to), launch('a', offsetToAxial({ col: 10, row: 6 }))],
      NO_ORDERS,
      0,
    );

    expect(positionOf(result.state, 'a')).toEqual(CENTER);
    expect(result.events).toEqual([]);
  });

  it('one unit going over budget does not disturb the rest of the batch', () => {
    const n = neighbors(CENTER);
    const bStart = offsetToAxial({ col: 4, row: 4 });
    const bTo = neighbors(bStart)[0];
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('b', 'p1', 'launcher', bStart),
    ]);

    const result = resolve(
      state,
      [move('a', n[0]), move('a', n[1]), move('b', bTo)],
      NO_ORDERS,
      0,
    );

    expect(positionOf(result.state, 'a')).toEqual(CENTER);
    expect(positionOf(result.state, 'b')).toEqual(bTo);
  });
});

// --- orders belonging to later build-order steps ----------------------------

describe('resolve() — orders not yet implemented', () => {
  it('accepts LAUNCH and FLY orders without acting on them or throwing', () => {
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('eye', 'p1', 'drone', offsetToAxial({ col: 10, row: 12 })),
    ]);

    const result = resolve(
      state,
      [
        launch('a', offsetToAxial({ col: 10, row: 6 })),
        { type: 'FLY', unitId: 'eye', destination: offsetToAxial({ col: 10, row: 7 }) },
      ],
      NO_ORDERS,
      0,
    );

    expect(result.events).toEqual([]);
  });
});

// --- the skeleton's own contract --------------------------------------------

describe('resolve() — round bookkeeping and purity', () => {
  it('advances the round and returns to ORDER_PHASE', () => {
    const state = openField([makeUnit('a', 'p1', 'launcher', CENTER)]);

    const result = resolve(state, NO_ORDERS, NO_ORDERS, 0);

    expect(result.state.round).toBe(2);
    expect(result.state.phase).toBe('ORDER_PHASE');
  });

  it('does not mutate the state it was given', () => {
    const to = neighbors(CENTER)[0];
    const state = openField([makeUnit('a', 'p1', 'launcher', CENTER)]);
    const before = structuredClone(state);

    resolve(state, [move('a', to)], NO_ORDERS, 0);

    expect(state).toEqual(before);
  });
});

// --- determinism (spec §6) --------------------------------------------------

describe('resolve() — determinism', () => {
  /** A round with a move, a standoff, a block, and a dropped order in it. */
  function busyRound(): {
    state: GameState;
    p1: Order[];
    p2: Order[];
  } {
    const n = neighbors(CENTER);
    const far = offsetToAxial({ col: 4, row: 4 });
    const state = openField([
      makeUnit('a', 'p1', 'launcher', n[0]),
      makeUnit('b', 'p1', 'launcher', far),
      makeUnit('eye', 'p1', 'drone', offsetToAxial({ col: 15, row: 15 })),
      makeUnit('z', 'p2', 'launcher', n[3]),
      makeUnit('y', 'p2', 'launcher', offsetToAxial({ col: 18, row: 4 })),
    ]);
    return {
      state,
      p1: [move('a', CENTER), move('b', neighbors(far)[0]), move('eye', CENTER)],
      p2: [move('z', CENTER), move('y', neighbors(offsetToAxial({ col: 18, row: 4 }))[0])],
    };
  }

  it('produces deep-equal results from identical inputs', () => {
    const first = busyRound();
    const second = busyRound();

    const a = resolve(first.state, first.p1, first.p2, 0);
    const b = resolve(second.state, second.p1, second.p2, 0);

    expect(a.state).toEqual(b.state);
    expect(a.events).toEqual(b.events);
  });

  it('ignores the seed entirely — V1 resolution reads no randomness', () => {
    const first = busyRound();
    const second = busyRound();

    const a = resolve(first.state, first.p1, first.p2, 1);
    const b = resolve(second.state, second.p1, second.p2, 999_999);

    expect(a.state).toEqual(b.state);
    expect(a.events).toEqual(b.events);
  });

  it('emits events in unit order, not in the order the client listed them', () => {
    const aStart = CENTER;
    const bStart = offsetToAxial({ col: 4, row: 4 });
    const units = [
      makeUnit('a', 'p1', 'launcher', aStart),
      makeUnit('b', 'p1', 'launcher', bStart),
    ];
    const orders = [
      move('b', neighbors(bStart)[0]),
      move('a', neighbors(aStart)[0]),
    ];

    const result = resolve(openField(units), orders, NO_ORDERS, 0);

    // Submitted b-then-a; logged a-then-b, because state.units is canonical.
    expect(result.events.map((e) => ('unitId' in e ? e.unitId : null))).toEqual([
      'a',
      'b',
    ]);
  });

  it('reversing both order arrays cannot change the outcome', () => {
    const forward = busyRound();
    const reversed = busyRound();

    const a = resolve(forward.state, forward.p1, forward.p2, 0);
    const b = resolve(
      reversed.state,
      [...reversed.p1].reverse(),
      [...reversed.p2].reverse(),
      0,
    );

    expect(a.state).toEqual(b.state);
    expect(a.events).toEqual(b.events);
  });
});
