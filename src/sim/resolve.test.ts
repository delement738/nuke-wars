import { describe, expect, it } from 'vitest';
import { RULES, SPAWNS, UNIT_DEFS } from './defs';
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
import { missileIdFor } from './missiles';
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

function fly(unitId: string, destination: Hex): Order {
  return { type: 'FLY', unitId, destination };
}

/** A hex comfortably inside a 21x21 map, so edge clipping never interferes. */
const CENTER: Hex = offsetToAxial({ col: 10, row: 10 });

/** The drone's flight range, read from the balance table rather than hardcoded. */
const FLIGHT = UNIT_DEFS.drone.movement;

/** A hex exactly `steps` away, walking due north (up the board's long axis). */
function north(from: Hex, steps: number): Hex {
  const offset = axialToOffset(from);
  return offsetToAxial({ col: offset.col, row: offset.row - steps });
}

function openField(units: Unit[] = []): GameState {
  return makeState(makeMap(21, 21), units);
}

/**
 * A living launcher parked in a far corner, out of every fixture's way.
 *
 * A board where one side's *only* launcher is a corpse is a board §4 would have
 * ended by disarmament before this round could be played, so phase 4 stops it at
 * the outcome check. Handing that side a spare keeps these tests about what they
 * were always about — blocking, order dropping, post-impact movement — instead
 * of about the win conditions, which have their own describe block below.
 */
function spare(owner: PlayerId): Unit {
  const corner = owner === 'p1' ? { col: 0, row: 20 } : { col: 20, row: 0 };
  return makeUnit(`${owner}-spare`, owner, 'launcher', offsetToAxial(corner));
}

/** Position of a unit in a resolved state, by id. */
function positionOf(state: GameState, id: UnitId): Hex {
  const unit = state.units.find((u) => u.id === id);
  if (!unit) throw new Error(`no unit ${id}`);
  return unit.position;
}

function unitOf(state: GameState, id: UnitId): Unit {
  const unit = state.units.find((u) => u.id === id);
  if (!unit) throw new Error(`no unit ${id}`);
  return unit;
}

function eventsFor(events: GameEvent[], id: UnitId): GameEvent[] {
  return events.filter((e) => 'unitId' in e && e.unitId === id);
}

/** The DRONE_MOVED a drone emits when it stays put — its own hex's swath. */
function hovered(unitId: string, owner: PlayerId, hex: Hex): GameEvent {
  return { type: 'DRONE_MOVED', unitId, owner, from: hex, to: hex, path: [hex] };
}

function spotted(events: GameEvent[]): GameEvent[] {
  return events.filter((e) => e.type === 'ASSET_SPOTTED');
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
      { type: 'UNIT_MOVED', unitId: 'a', owner: 'p1', from: CENTER, to },
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
      { type: 'MOVE_FAILED', unitId: 'a', owner: 'p1' },
      { type: 'MOVE_FAILED', unitId: 'z', owner: 'p2' },
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
      { type: 'MOVE_FAILED', unitId: 'a', owner: 'p1' },
    ]);
    expect(eventsFor(result.events, 'z')).toEqual([
      { type: 'MOVE_FAILED', unitId: 'z', owner: 'p2' },
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
      { type: 'MOVE_FAILED', unitId: 'b', owner: 'p1' },
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
      { type: 'MOVE_FAILED', unitId: 'a', owner: 'p1' },
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
      { type: 'MOVE_FAILED', unitId: 'a', owner: 'p1' },
    ]);
  });

  it('a destroyed unit blocks nothing', () => {
    const target = neighbors(CENTER)[0];
    const corpse = makeUnit('z', 'p2', 'launcher', target);
    corpse.destroyed = true;
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      corpse,
      spare('p2'),
    ]);

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
      { type: 'MOVE_FAILED', unitId: 'a', owner: 'p1' },
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
    // No UNIT_MOVED and no MOVE_FAILED: the rejection was caused by public
    // information, so nothing is reported. The one event is phase 1's hover.
    expect(result.events).toEqual([hovered('eye', 'p1', CENTER)]);
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
    const state = openField([dead, spare('p1')]);

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

// --- phase 2: launch & interception (spec §3, §10, §11) ---------------------

describe('resolve() — phase 2: launch & interception', () => {
  it('fires a missile: the launch is public, the origin marks the DEFENDER’s map', () => {
    const target = north(CENTER, 3);
    const state = openField([makeUnit('a', 'p1', 'launcher', CENTER)]);

    const result = resolve(state, [launch('a', target)], NO_ORDERS, 0);

    const missileId = missileIdFor(state.round, CENTER);
    expect(result.events).toEqual([
      { type: 'LAUNCH_DETECTED', missileId, origin: CENTER, target },
      // Fires even though the hex is empty — see the IMPACT tests below.
      { type: 'IMPACT', missileId, hex: target },
    ]);
    // Intel is keyed by the VIEWER: p1's launch marks p2's map, not p1's.
    expect(result.state.intel.p2.contacts).toEqual([
      { hex: CENTER, source: 'LAUNCH' },
    ]);
    expect(result.state.intel.p1.contacts).toEqual([]);
  });

  it('a launch contact cannot be stale — the firer could not also have moved', () => {
    const state = openField([makeUnit('a', 'p1', 'launcher', CENTER)]);

    const result = resolve(state, [launch('a', north(CENTER, 3))], NO_ORDERS, 0);

    // One order per unit (§9), so the launcher is still standing on the origin
    // when the round ends. That is what makes a detected launch a live target
    // for exactly one round, and firing a hard commitment (§3, §11).
    expect(positionOf(result.state, 'a')).toEqual(CENTER);
    expect(result.state.intel.p2.contacts).toEqual([
      { hex: CENTER, source: 'LAUNCH' },
    ]);
  });

  it('the contact expires after one order phase, like any launcher sighting', () => {
    const state = openField([makeUnit('a', 'p1', 'launcher', CENTER)]);

    const fired = resolve(state, [launch('a', north(CENTER, 3))], NO_ORDERS, 0);
    const later = resolve(fired.state, NO_ORDERS, NO_ORDERS, 0);

    expect(later.state.intel.p2.contacts).toEqual([]);
    // The permanent record is the log, not the map (§6, §11).
    expect(fired.events.some((e) => e.type === 'LAUNCH_DETECTED')).toBe(true);
  });

  it('records one contact when recon and launch detection see the same launcher', () => {
    const enemy = north(CENTER, 2);
    const state = openField([
      makeUnit('spy', 'p2', 'drone', north(CENTER, 4)),
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('z', 'p2', 'launcher', enemy),
    ]);

    // p2's drone hovers over p1's launcher hex while p1 fires from it.
    const result = resolve(state, [launch('a', enemy)], [fly('spy', CENTER)], 0);

    // Keyed by hex, so one entry — and the two detectors agree, because a
    // launcher that fired cannot have moved.
    expect(result.state.intel.p2.contacts).toEqual([
      { hex: CENTER, source: 'RECON' },
    ]);
  });

  it.each([
    ['out of range', () => north(CENTER, RULES.missileRange + 1)],
    ['its own hex', () => CENTER],
    ['off the map', () => offsetToAxial({ col: -4, row: -4 })],
  ])('drops a LAUNCH aimed %s in silence', (_label, targetOf) => {
    const state = openField([makeUnit('a', 'p1', 'launcher', CENTER)]);

    const result = resolve(state, [launch('a', targetOf())], NO_ORDERS, 0);

    // No air-layer MOVE_FAILED: every way a LAUNCH can be rejected is derivable
    // from the player's own units plus the public map, so hidden information
    // cannot have caused it and there is nothing to report (§9's policy).
    expect(result.events).toEqual([]);
    expect(result.state.intel.p2.contacts).toEqual([]);
  });

  it('drops a LAUNCH naming the ENEMY’s launcher without a whisper', () => {
    const state = openField([makeUnit('z', 'p2', 'launcher', CENTER)]);

    const result = resolve(state, [launch('z', north(CENTER, 3))], NO_ORDERS, 0);

    // Acting on it would fire p2's missile on p1's say-so; reporting it would
    // put a real enemy unit id into p1's log (§9, §11).
    expect(result.events).toEqual([]);
  });

  it('drops a LAUNCH naming the drone — it carries no missile', () => {
    const state = openField([makeUnit('eye', 'p1', 'drone', CENTER)]);

    const result = resolve(state, [launch('eye', north(CENTER, 3))], NO_ORDERS, 0);

    // The one event is phase 1's hover: the drone still watches.
    expect(result.events).toEqual([hovered('eye', 'p1', CENTER)]);
  });

  it('an intercepted missile is announced and never lands', () => {
    const victim = north(CENTER, 5);
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('base', 'p2', 'interceptor', north(CENTER, 3)),
      makeUnit('z', 'p2', 'launcher', victim),
    ]);

    const result = resolve(state, [launch('a', victim)], NO_ORDERS, 0);

    const missileId = missileIdFor(state.round, CENTER);
    expect(result.events).toEqual([
      { type: 'LAUNCH_DETECTED', missileId, origin: CENTER, target: victim },
      // Killed on the first covered hex it entered — the bubble starts one hex
      // before the base itself (coverage radius 1).
      { type: 'MISSILE_INTERCEPTED', missileId, hex: north(CENTER, 2) },
    ]);
    expect(unitOf(result.state, 'z').destroyed).toBe(false);
  });

  it('MISSILE_INTERCEPTED names no base — the attacker gets 7 candidates', () => {
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('base', 'p2', 'interceptor', north(CENTER, 3)),
    ]);

    const result = resolve(state, [launch('a', north(CENTER, 5))], NO_ORDERS, 0);
    const intercept = result.events.find((e) => e.type === 'MISSILE_INTERCEPTED')!;

    // Probing lanes with cheap missiles is legitimate strategy (§10) — but all
    // it buys is "some base covers that hex". Bases reach a map only via recon.
    expect(Object.keys(intercept).sort()).toEqual(['hex', 'missileId', 'type']);
  });

  it('saturation beats the cap: two missiles down one lane, the second lands', () => {
    // The per-round cap is the stalemate-breaker for the whole design (§10):
    // without it a base is unkillable, because any missile aimed at one must
    // cross its own coverage to get there.
    expect(RULES.interceptsPerRound).toBe(1);
    const south = north(CENTER, -1);
    const victim = north(CENTER, 4);
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('b', 'p1', 'launcher', south),
      makeUnit('base', 'p2', 'interceptor', north(CENTER, 2)),
      makeUnit('z', 'p2', 'launcher', victim),
    ]);

    const result = resolve(
      state,
      [launch('a', victim), launch('b', victim)],
      NO_ORDERS,
      0,
    );

    const types = result.events.map((e) => e.type);
    expect(types.filter((t) => t === 'MISSILE_INTERCEPTED')).toHaveLength(1);
    expect(types.filter((t) => t === 'IMPACT')).toHaveLength(1);
    expect(unitOf(result.state, 'z').destroyed).toBe(true);
  });

  it('a base kills a drone AND still intercepts a missile in the same round', () => {
    // Drone kills are free and never consume the missile intercept (§2, §10).
    const westHex = offsetToAxial({ col: 9, row: 10 });
    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('a', 'p1', 'launcher', westHex),
      makeUnit('base', 'p2', 'interceptor', north(CENTER, 3)),
    ]);

    const result = resolve(
      state,
      [fly('eye', north(CENTER, FLIGHT)), launch('a', north(westHex, 5))],
      NO_ORDERS,
      0,
    );

    const types = result.events.map((e) => e.type);
    expect(types).toContain('DRONE_DOWNED');
    expect(types).toContain('MISSILE_INTERCEPTED');
    expect(types).not.toContain('IMPACT');
  });
});

// --- phase 3: impact (spec §3, §6, §12) -------------------------------------

describe('resolve() — phase 3: impact', () => {
  /** p1 fires from CENTER at `target`; nothing else is on the board but `units`. */
  function strike(target: Hex, units: Unit[] = [], extra: Order[] = []) {
    const state = openField([makeUnit('a', 'p1', 'launcher', CENTER), ...units]);
    return {
      state,
      result: resolve(state, [launch('a', target), ...extra], NO_ORDERS, 0),
    };
  }

  it('fires IMPACT on empty ground, and never names a victim', () => {
    const target = north(CENTER, 3);
    const { result } = strike(target);

    // Load-bearing: if IMPACT only fired when something was struck, its mere
    // presence would reveal the hex was occupied, and blind-fire probing would
    // find bunkers and bases for free (§6).
    const impact = result.events.find((e) => e.type === 'IMPACT')!;
    expect(impact).toEqual({
      type: 'IMPACT',
      missileId: missileIdFor(1, CENTER),
      hex: target,
    });
  });

  it('destroys a launcher outright, publicly, and stops it moving', () => {
    const target = north(CENTER, 3);
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('z', 'p2', 'launcher', target),
    ]);

    // p2 tries to drive away — but strikes land in phase 3 and movement is
    // phase 5, so firing is a hard commitment and fleeing is too late (§3).
    const result = resolve(
      state,
      [launch('a', target)],
      [move('z', north(target, 3))],
      0,
    );

    const victim = unitOf(result.state, 'z');
    expect(victim.destroyed).toBe(true);
    expect(victim.position).toEqual(target);
    expect(result.events).toContainEqual({
      type: 'UNIT_DESTROYED',
      unitId: 'z',
      kind: 'launcher',
      hex: target,
    });
    expect(result.events.some((e) => e.type === 'UNIT_MOVED')).toBe(false);
  });

  it('the real bunker takes 1 of its 2 hits, and only its owner is told', () => {
    const site = north(CENTER, 3);
    const { result } = strike(site, [makeUnit('real', 'p2', 'bunker', site)]);

    const bunker = unitOf(result.state, 'real');
    expect(bunker.destroyed).toBe(false);
    expect(bunker.hp).toBe(UNIT_DEFS.bunker.hp - 1);
    expect(result.events).toContainEqual({
      type: 'BUNKER_HIT',
      unitId: 'real',
      owner: 'p2',
      hex: site,
      hpRemaining: 1,
    });
    // To the attacker this round looks exactly like hitting bare ground.
    expect(result.events.some((e) => e.type === 'UNIT_DESTROYED')).toBe(false);
  });

  it('hits STACK: two missiles kill a full-health bunker in one round', () => {
    const site = north(CENTER, 3);
    const south = north(CENTER, -1);
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('b', 'p1', 'launcher', south),
      makeUnit('real', 'p2', 'bunker', site),
    ]);

    const result = resolve(state, [launch('a', site), launch('b', site)], NO_ORDERS, 0);

    // The alpha strike (§3, §12): skip the decoy test at the price of a wasted
    // missile if the site turns out to be the fake.
    expect(unitOf(result.state, 'real').destroyed).toBe(true);
    expect(result.events.filter((e) => e.type === 'IMPACT')).toHaveLength(2);
    expect(result.events.some((e) => e.type === 'BUNKER_HIT')).toBe(false);
  });

  it('a decoy dies to one hit, reported truthfully as a decoy', () => {
    const site = north(CENTER, 3);
    const { result } = strike(site, [makeUnit('fake', 'p2', 'decoy', site)]);

    expect(result.events).toContainEqual({
      type: 'UNIT_DESTROYED',
      unitId: 'fake',
      kind: 'decoy',
      hex: site,
    });
    // THE tell (§12): a destroyed site was the fake; silence after a hit means
    // the real bunker absorbed 1 of its 2. A decoy never emits BUNKER_HIT
    // because it never survives one.
    expect(result.events.some((e) => e.type === 'BUNKER_HIT')).toBe(false);
  });

  it('kills a bunker built on a MOUNTAIN exactly like one on plains', () => {
    const site = north(CENTER, 3);
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('b', 'p1', 'launcher', north(CENTER, -1)),
      makeUnit('real', 'p2', 'bunker', site),
    ]);
    setTerrain(state.map, site, 'mountain');

    const result = resolve(state, [launch('a', site), launch('b', site)], NO_ORDERS, 0);

    // Static structures may be built on mountains (§12), so if targeting or
    // flight filtered impassable hexes a mountain bunker would be invulnerable
    // — a guaranteed win for the defender (§10).
    expect(unitOf(result.state, 'real').destroyed).toBe(true);
  });

  it('is aimed at ground, not at a target: friendly fire kills your own', () => {
    const own = north(CENTER, 3);
    const { result } = strike(own, [makeUnit('mine', 'p1', 'launcher', own)]);

    expect(unitOf(result.state, 'mine').destroyed).toBe(true);
  });

  it('cannot touch a drone hovering over the target hex (§2 air layer)', () => {
    const target = north(CENTER, 3);
    const { result } = strike(target, [makeUnit('spy', 'p2', 'drone', target)]);

    const drone = unitOf(result.state, 'spy');
    expect(drone.destroyed).toBe(false);
    expect(result.events.some((e) => e.type === 'UNIT_DESTROYED')).toBe(false);
    // IMPACT still fires — it always does, whatever is or isn't standing there.
    expect(result.events.some((e) => e.type === 'IMPACT')).toBe(true);
  });

  it('leaves an already-destroyed unit alone — no second death', () => {
    const target = north(CENTER, 3);
    const corpse = makeUnit('z', 'p2', 'launcher', target);
    corpse.destroyed = true;
    const { result } = strike(target, [corpse]);

    expect(result.events.some((e) => e.type === 'UNIT_DESTROYED')).toBe(false);
  });

  it('public destruction clears the enemy’s map of that asset (§11)', () => {
    const site = north(CENTER, 3);
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('b', 'p1', 'launcher', north(CENTER, -1)),
      makeUnit('base', 'p2', 'interceptor', site),
    ]);
    // p1 photographed the base in an earlier round; the sighting is permanent
    // — until the asset is publicly destroyed, which is exactly now.
    state.intel.p1.staticReveals.push({ hex: site, kind: 'interceptor', round: 1 });

    // It takes TWO missiles, and that is the design working: a base is
    // self-protecting, because any missile aimed at one must cross its own
    // coverage to reach it. The first is eaten, the second gets through — which
    // is precisely why the per-round cap exists (§10).
    const result = resolve(state, [launch('a', site), launch('b', site)], NO_ORDERS, 0);

    expect(unitOf(result.state, 'base').destroyed).toBe(true);
    expect(result.state.intel.p1.staticReveals).toEqual([]);
  });

  it('counter-battery clears the launch contact it was fired at', () => {
    const enemy = north(CENTER, 4);
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('z', 'p2', 'launcher', enemy),
    ]);

    // Both fire at each other's hexes in the same round: both missiles are in
    // flight simultaneously, so both launchers die. §3 needs no rule for this.
    const result = resolve(state, [launch('a', enemy)], [launch('z', CENTER)], 0);

    expect(unitOf(result.state, 'a').destroyed).toBe(true);
    expect(unitOf(result.state, 'z').destroyed).toBe(true);
    // The contact each side filed this round is for a launcher both players
    // just watched die — the map shows only what is true right now (§11).
    expect(result.state.intel.p1.contacts).toEqual([]);
    expect(result.state.intel.p2.contacts).toEqual([]);
  });

  it('hands phase 5 a post-impact board: a destroyed blocker no longer blocks', () => {
    const contested = north(CENTER, 1);
    const gunner = offsetToAxial({ col: 8, row: 10 });
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('b', 'p1', 'launcher', gunner),
      makeUnit('z', 'p2', 'launcher', contested),
      spare('p2'),
    ]);

    // 'b' shells the hex 'a' is driving into. Phase 3 runs before phase 5, so
    // by the time movement is validated the blocker is a corpse — and corpses
    // block nothing (§9).
    const result = resolve(
      state,
      [launch('b', contested), move('a', contested)],
      NO_ORDERS,
      0,
    );

    expect(unitOf(result.state, 'z').destroyed).toBe(true);
    expect(positionOf(result.state, 'a')).toEqual(contested);
  });
});

// --- the shape of the round's log -------------------------------------------

describe('resolve() — event log ordering', () => {
  it('emits the round in phase order, so a client can animate straight through', () => {
    const site = north(CENTER, 2);
    const gunner = offsetToAxial({ col: 8, row: 10 });
    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('b', 'p1', 'launcher', gunner),
      makeUnit('fake', 'p2', 'decoy', site),
      makeUnit('base', 'p2', 'interceptor', north(CENTER, 5)),
    ]);

    const result = resolve(
      state,
      [
        fly('eye', north(CENTER, 2)), // sees the decoy, survives
        launch('a', north(CENTER, 4)), // flies into the bubble, intercepted
        launch('b', site), // destroys the decoy
      ],
      NO_ORDERS,
      0,
    );

    expect(result.events.map((e) => e.type)).toEqual([
      // Phase 1 — recon.
      'DRONE_MOVED',
      'ASSET_SPOTTED',
      // Phase 2 — the whole volley leaves the ground, then defenses engage.
      'LAUNCH_DETECTED',
      'LAUNCH_DETECTED',
      'MISSILE_INTERCEPTED',
      // Phase 3 — arrivals first (never naming a victim), then the damage.
      'IMPACT',
      'UNIT_DESTROYED',
    ]);
  });
});

// --- phase 1: recon flight (spec §3, §10, §11) ------------------------------

describe('resolve() — phase 1: drone flight', () => {
  it('flies the drone and logs the path the swath came from', () => {
    const destination = north(CENTER, FLIGHT);
    const state = openField([makeUnit('eye', 'p1', 'drone', CENTER)]);

    const result = resolve(state, [fly('eye', destination)], NO_ORDERS, 0);

    expect(positionOf(result.state, 'eye')).toEqual(destination);
    expect(result.events).toEqual([
      {
        type: 'DRONE_MOVED',
        unitId: 'eye',
        owner: 'p1',
        from: CENTER,
        to: destination,
        path: hexLine(CENTER, destination),
      },
    ]);
  });

  it('an un-ordered drone hovers, and a hovering drone still watches', () => {
    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('z', 'p2', 'launcher', neighbors(CENTER)[0]),
    ]);

    const result = resolve(state, NO_ORDERS, NO_ORDERS, 0);

    expect(positionOf(result.state, 'eye')).toEqual(CENTER);
    expect(result.events[0]).toEqual(hovered('eye', 'p1', CENTER));
    // The corridor around its own hex is a real swath — this is what makes
    // "give no order to hover" a choice rather than a wasted round.
    expect(result.state.intel.p1.contacts).toEqual([
      { hex: neighbors(CENTER)[0], source: 'RECON' },
    ]);
  });

  it('drops an out-of-range FLY silently — the drone hovers instead', () => {
    const state = openField([makeUnit('eye', 'p1', 'drone', CENTER)]);

    const result = resolve(state, [fly('eye', north(CENTER, FLIGHT + 1))], NO_ORDERS, 0);

    expect(positionOf(result.state, 'eye')).toEqual(CENTER);
    // No failure event: nothing hidden caused this, so there is nothing to
    // report (the air-layer counterpart of §9's MOVE_FAILED policy).
    expect(result.events).toEqual([hovered('eye', 'p1', CENTER)]);
  });

  it('FLY + MOVE for one drone is over budget — it hovers and does neither', () => {
    const destination = north(CENTER, 3);
    const state = openField([makeUnit('eye', 'p1', 'drone', CENTER)]);

    const result = resolve(
      state,
      [fly('eye', destination), move('eye', neighbors(CENTER)[0])],
      NO_ORDERS,
      0,
    );

    expect(positionOf(result.state, 'eye')).toEqual(CENTER);
    expect(result.events).toEqual([hovered('eye', 'p1', CENTER)]);
  });

  it('ignores a FLY order aimed at the enemy’s drone', () => {
    const state = openField([makeUnit('spy', 'p2', 'drone', CENTER)]);

    // p1 submits an order naming p2's drone; it is never even consulted, since
    // each drone reads only its own owner's order book.
    const result = resolve(state, [fly('spy', north(CENTER, 4))], NO_ORDERS, 0);

    expect(positionOf(result.state, 'spy')).toEqual(CENTER);
    expect(result.events).toEqual([hovered('spy', 'p2', CENTER)]);
  });

  it('photographs launchers at their PRE-move positions (§3 phase order)', () => {
    const launcherStart = neighbors(CENTER)[0];
    const away = north(launcherStart, UNIT_DEFS.launcher.movement);
    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('z', 'p2', 'launcher', launcherStart),
    ]);

    const result = resolve(state, NO_ORDERS, [move('z', away)], 0);

    // Recon flew in phase 1, the launcher drove off in phase 5 — so the contact
    // is already stale when the player acts on it. Shooting at it is a bet.
    expect(positionOf(result.state, 'z')).toEqual(away);
    expect(result.state.intel.p1.contacts).toEqual([
      { hex: launcherStart, source: 'RECON' },
    ]);
  });

  it('a flying drone does not block a launcher’s advance (§2 air layer)', () => {
    const contested = neighbors(CENTER)[0];
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('spy', 'p2', 'drone', north(CENTER, 3)),
    ]);

    // p2 parks its drone on the exact hex p1's launcher is driving to.
    const result = resolve(state, [move('a', contested)], [fly('spy', contested)], 0);

    // If the drone blocked, it would be a third detector by the back door:
    // park it, watch the advance fail, and you have found a unit for free.
    expect(positionOf(result.state, 'a')).toEqual(contested);
    expect(positionOf(result.state, 'spy')).toEqual(contested);
    expect(eventsFor(result.events, 'a')).toEqual([
      {
        type: 'UNIT_MOVED',
        unitId: 'a',
        owner: 'p1',
        from: CENTER,
        to: contested,
      },
    ]);
  });
});

// --- recon reveals and the two-part intel state (spec §11) ------------------

describe('resolve() — recon reveals', () => {
  it('files a spotted launcher as a one-round contact', () => {
    const target = north(CENTER, 4);
    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('z', 'p2', 'launcher', target),
    ]);

    const result = resolve(state, [fly('eye', target)], NO_ORDERS, 0);

    expect(spotted(result.events)).toEqual([
      { type: 'ASSET_SPOTTED', kind: 'launcher', hex: target, owner: 'p2' },
    ]);
    expect(result.state.intel.p1.contacts).toEqual([
      { hex: target, source: 'RECON' },
    ]);
    expect(result.state.intel.p1.staticReveals).toEqual([]);
  });

  it('files static assets permanently, and stores the DECOY truthfully', () => {
    const line = hexLine(CENTER, north(CENTER, FLIGHT));
    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('real', 'p2', 'bunker', line[2]),
      makeUnit('fake', 'p2', 'decoy', neighbors(line[4])[0]),
    ]);

    const result = resolve(state, [fly('eye', line[line.length - 1])], NO_ORDERS, 0);

    // resolve() never lies. The decoy -> bunker mask is the visibility filter's
    // job alone (step 8) — the sim stores the truth, 'decoy' and all.
    expect(result.state.intel.p1.staticReveals).toEqual([
      { hex: line[2], kind: 'bunker', round: 1 },
      { hex: neighbors(line[4])[0], kind: 'decoy', round: 1 },
    ]);
    expect(result.state.intel.p1.contacts).toEqual([]);
  });

  it('cannot photograph an interceptor base — it dies one hex short', () => {
    // NOT a quirk of this fixture: while RULES.reconSwathRadius <=
    // RULES.interceptorCoverageRadius, any base near enough to fall inside the
    // swath is covering a hex the drone must enter to get it. Brute-forced over
    // every flight geometry — see the note on reconSwathRadius in defs.ts.
    expect(RULES.reconSwathRadius).toBeLessThanOrEqual(
      RULES.interceptorCoverageRadius,
    );

    const destination = north(CENTER, FLIGHT);
    const line = hexLine(CENTER, destination);
    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('base', 'p2', 'interceptor', line[3]),
    ]);

    const result = resolve(state, [fly('eye', destination)], NO_ORDERS, 0);

    expect(unitOf(result.state, 'eye').destroyed).toBe(true);
    expect(result.state.intel.p1.staticReveals).toEqual([]);
    // All the owner gets is the death hex, leaving 7 candidates (§6, §11).
    expect(result.events).toContainEqual({
      type: 'DRONE_DOWNED',
      unitId: 'eye',
      owner: 'p1',
      hex: line[2],
    });
  });

  it('never reveals the enemy drone — drones do not see each other', () => {
    const target = north(CENTER, 4);
    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('spy', 'p2', 'drone', target),
    ]);

    const result = resolve(state, [fly('eye', target)], NO_ORDERS, 0);

    expect(spotted(result.events)).toEqual([]);
    expect(result.state.intel.p1.contacts).toEqual([]);
    expect(result.state.intel.p1.staticReveals).toEqual([]);
  });

  it('never files your own assets as intel, nor an enemy corpse', () => {
    const target = north(CENTER, 3);
    const corpse = makeUnit('z', 'p2', 'launcher', neighbors(target)[0]);
    corpse.destroyed = true;
    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('a', 'p1', 'launcher', neighbors(CENTER)[0]),
      makeUnit('mine', 'p1', 'bunker', neighbors(target)[3]),
      corpse,
    ]);

    const result = resolve(state, [fly('eye', target)], NO_ORDERS, 0);

    expect(spotted(result.events)).toEqual([]);
    expect(result.state.intel.p1).toEqual({ staticReveals: [], contacts: [] });
  });

  it('ignores anything outside the corridor', () => {
    const target = north(CENTER, 4);
    const line = hexLine(CENTER, target);
    const mid = axialToOffset(line[2]);
    const outside = offsetToAxial({ col: mid.col + 3, row: mid.row });
    // Guard the premise: nothing on the flight path comes within reach of it.
    const closest = Math.min(...line.map((hex) => distance(hex, outside)));
    expect(closest).toBeGreaterThan(RULES.reconSwathRadius);

    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('z', 'p2', 'launcher', outside),
    ]);

    const result = resolve(state, [fly('eye', target)], NO_ORDERS, 0);

    expect(result.state.intel.p1.contacts).toEqual([]);
  });

  it('rebuilds contacts from scratch every round — no stale ghost markers', () => {
    const seen = north(CENTER, 2);
    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('z', 'p2', 'launcher', seen),
    ]);

    // Overfly the launcher and keep going, so the drone ends the round well
    // clear of it — the start hex is always in next round's swath.
    const first = resolve(state, [fly('eye', north(CENTER, FLIGHT))], NO_ORDERS, 0);
    expect(first.state.intel.p1.contacts).toEqual([{ hex: seen, source: 'RECON' }]);

    // Next round it looks somewhere else entirely.
    const second = resolve(
      first.state,
      [fly('eye', north(CENTER, FLIGHT + 4))],
      NO_ORDERS,
      0,
    );

    // The sighting is gone from the map after exactly one order phase. Its
    // permanent record lives in the event log, not here (§11).
    expect(second.state.intel.p1.contacts).toEqual([]);
  });

  it('keeps a static reveal forever, once, with its first-seen round', () => {
    const site = north(CENTER, 2);
    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('real', 'p2', 'bunker', site),
    ]);

    const first = resolve(state, [fly('eye', site)], NO_ORDERS, 0);
    const second = resolve(first.state, [fly('eye', north(site, 2))], NO_ORDERS, 0);

    expect(second.state.round).toBe(3);
    // Re-photographing a building that cannot move is not news: one entry, and
    // `round` still reads 1.
    expect(second.state.intel.p1.staticReveals).toEqual([
      { hex: site, kind: 'bunker', round: 1 },
    ]);
    // ...but the sighting event fires again, because the drone did see it.
    expect(spotted(second.events)).toHaveLength(1);
  });

  it('records an asset seen twice in one swath only once', () => {
    // A launcher one hex off the path sits inside the corridor of several
    // consecutive path hexes.
    const target = north(CENTER, 4);
    const line = hexLine(CENTER, target);
    const beside = neighbors(line[2])[0];
    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('z', 'p2', 'launcher', beside),
    ]);

    const result = resolve(state, [fly('eye', target)], NO_ORDERS, 0);

    expect(spotted(result.events)).toHaveLength(1);
    expect(result.state.intel.p1.contacts).toEqual([{ hex: beside, source: 'RECON' }]);
  });

  it('both players’ drones fly and report in the same round', () => {
    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('a', 'p1', 'launcher', neighbors(CENTER)[0]),
      makeUnit('spy', 'p2', 'drone', north(CENTER, 5)),
      makeUnit('z', 'p2', 'launcher', north(CENTER, 4)),
    ]);

    // The two sweeps cross: p1 flies north over z, p2 flies south over a.
    const result = resolve(
      state,
      [fly('eye', north(CENTER, 4))],
      [fly('spy', north(CENTER, -1))],
      0,
    );

    expect(result.state.intel.p1.contacts).toEqual([
      { hex: north(CENTER, 4), source: 'RECON' },
    ]);
    expect(result.state.intel.p2.contacts).toEqual([
      { hex: neighbors(CENTER)[0], source: 'RECON' },
    ]);
  });
});

// --- drone loss and respawn (spec §10, §11) ---------------------------------

describe('resolve() — drone loss and respawn', () => {
  /** A drone at CENTER flying north into a base that covers `line[2]`. */
  function ambush(): { state: GameState; line: Hex[]; destination: Hex } {
    const destination = north(CENTER, FLIGHT);
    const line = hexLine(CENTER, destination);
    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('base', 'p2', 'interceptor', line[3]),
    ]);
    return { state, line, destination };
  }

  it('is destroyed entering coverage, and the wreck sits on the death hex', () => {
    const { state, line, destination } = ambush();

    const result = resolve(state, [fly('eye', destination)], NO_ORDERS, 0);

    const drone = unitOf(result.state, 'eye');
    expect(drone.destroyed).toBe(true);
    expect(drone.hp).toBe(0);
    expect(drone.position).toEqual(line[2]);
    expect(result.state.droneRespawnIn.p1).toBe(RULES.droneRespawnDelay - 1);
  });

  it('logs the transmitted path and the death hex separately', () => {
    const { state, line, destination } = ambush();

    const result = resolve(state, [fly('eye', destination)], NO_ORDERS, 0);

    expect(result.events).toEqual([
      // `path`/`to` stop one hex short of the kill: a downed drone transmits
      // nothing from where it died, so a client building the reveal overlay
      // from `path` is correct without knowing that rule.
      {
        type: 'DRONE_MOVED',
        unitId: 'eye',
        owner: 'p1',
        from: CENTER,
        to: line[1],
        path: [line[0], line[1]],
      },
      { type: 'DRONE_DOWNED', unitId: 'eye', owner: 'p1', hex: line[2] },
    ]);
  });

  it('keeps intel from before the kill, and sees nothing BEYOND the death hex', () => {
    const { state, line, destination } = ambush();
    state.units.push(makeUnit('early', 'p2', 'launcher', line[1]));
    // On the death hex itself. Still spotted — the drone photographed it from
    // line[1], one hex back, before it ever flew in. "Reveals nothing FROM its
    // death hex" (§11) means the death hex contributes no corridor of its own,
    // not that the hex is invisible.
    state.units.push(makeUnit('onDeathHex', 'p2', 'launcher', line[2]));
    // Two hexes past the kill — outside the last safe hex's corridor, so the
    // flight ends without ever seeing it.
    state.units.push(makeUnit('beyond', 'p2', 'launcher', line[4]));

    const result = resolve(state, [fly('eye', destination)], NO_ORDERS, 0);

    expect(result.state.intel.p1.contacts).toEqual([
      { hex: line[1], source: 'RECON' },
      { hex: line[2], source: 'RECON' },
    ]);
    // Ordering is chronological: it saw, then it died.
    expect(result.events.map((e) => e.type)).toEqual([
      'DRONE_MOVED',
      'ASSET_SPOTTED',
      'ASSET_SPOTTED',
      'DRONE_DOWNED',
    ]);
  });

  it('costs exactly one blind round, then respawns at the fixed spawn hex', () => {
    const { state, destination } = ambush();
    const spawn = offsetToAxial(SPAWNS.p1.drone);

    // Round 1: shot down.
    const downed = resolve(state, [fly('eye', destination)], NO_ORDERS, 0);
    expect(downed.state.droneRespawnIn.p1).toBe(1);
    expect(unitOf(downed.state, 'eye').destroyed).toBe(true);

    // Round 2: the blind round. The order is submitted and simply has no drone
    // to act on, so phase 1 produces no flight and no swath at all.
    const blind = resolve(downed.state, [fly('eye', destination)], NO_ORDERS, 0);
    expect(blind.events.filter((e) => e.type === 'DRONE_MOVED')).toEqual([]);

    // ...and it comes back for round 3's order phase.
    expect(blind.state.droneRespawnIn.p1).toBe(0);
    const drone = unitOf(blind.state, 'eye');
    expect(drone.destroyed).toBe(false);
    expect(drone.hp).toBe(UNIT_DEFS.drone.hp);
    expect(drone.position).toEqual(spawn);
    expect(blind.events).toContainEqual({
      type: 'DRONE_RESPAWNED',
      unitId: 'eye',
      owner: 'p1',
      hex: spawn,
    });

    // Round 3: it is orderable again.
    const back = resolve(blind.state, [fly('eye', north(spawn, 3))], NO_ORDERS, 0);
    expect(positionOf(back.state, 'eye')).toEqual(north(spawn, 3));
  });

  it('a blind player keeps permanent reveals but loses launcher contacts', () => {
    const { state, destination, line } = ambush();
    state.units.push(makeUnit('real', 'p2', 'bunker', line[1]));
    state.units.push(makeUnit('z', 'p2', 'launcher', neighbors(line[1])[0]));

    const downed = resolve(state, [fly('eye', destination)], NO_ORDERS, 0);
    expect(downed.state.intel.p1.staticReveals).toHaveLength(1);
    expect(downed.state.intel.p1.contacts).toHaveLength(1);

    const blind = resolve(downed.state, NO_ORDERS, NO_ORDERS, 0);

    // "Blind" means no drone, not amnesia: the bunker cannot move, so that
    // sighting stays true. The launcher contact expires on the normal schedule.
    expect(blind.state.intel.p1.staticReveals).toHaveLength(1);
    expect(blind.state.intel.p1.contacts).toEqual([]);
  });

  it('a friendly base never engages its owner’s drone', () => {
    const destination = north(CENTER, FLIGHT);
    const line = hexLine(CENTER, destination);
    const state = openField([
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('base', 'p1', 'interceptor', line[3]),
    ]);

    const result = resolve(state, [fly('eye', destination)], NO_ORDERS, 0);

    expect(unitOf(result.state, 'eye').destroyed).toBe(false);
    expect(result.state.droneRespawnIn.p1).toBe(0);
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

  it('names the audience on every owner-only event (spec §6)', () => {
    // The visibility filter is handed the log and a player id and nothing else
    // (`filterEventsForPlayer(events, playerId)`, §6), so it cannot look a
    // unitId up in a GameState to find out whose event this is. Any owner-only
    // event that does not carry `owner` is unroutable — it would have to be
    // dropped for both players or shown to both, and both are wrong.
    //
    // ASSET_SPOTTED is deliberately absent from this check: its `owner` is the
    // SPOTTED asset's side, so its audience is that player's opponent.
    const OWNER_ONLY = [
      'UNIT_MOVED',
      'MOVE_FAILED',
      'BUNKER_HIT',
      'DRONE_MOVED',
      'DRONE_RESPAWNED',
    ];

    // Both sides act, so a hardcoded or swapped `owner` fails rather than
    // passing by luck: p1 moves and flies, p2 moves and flies, and the two
    // launchers contest one hex so each side also gets a MOVE_FAILED.
    const contested = north(CENTER, 3);
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('b', 'p1', 'launcher', north(CENTER, 2)),
      makeUnit('eye', 'p1', 'drone', CENTER),
      makeUnit('z', 'p2', 'launcher', north(CENTER, 6)),
      makeUnit('y', 'p2', 'launcher', north(CENTER, 4)),
      makeUnit('spy', 'p2', 'drone', north(CENTER, 8)),
    ]);

    const { events } = resolve(
      state,
      [move('a', neighbors(CENTER)[0]), move('b', contested), fly('eye', north(CENTER, 5))],
      [move('z', north(CENTER, 7)), move('y', contested), fly('spy', north(CENTER, 2))],
      0,
    );

    const owned = events.filter((e) => OWNER_ONLY.includes(e.type));
    // The fixture must actually exercise the rule, and from both sides.
    expect(owned.filter((e) => 'owner' in e && e.owner === 'p1').length)
      .toBeGreaterThan(0);
    expect(owned.filter((e) => 'owner' in e && e.owner === 'p2').length)
      .toBeGreaterThan(0);

    for (const event of owned) {
      // Each event must agree with the true owner of the unit it names, or the
      // filter would route a player's own event to their opponent.
      const named = state.units.find(
        (u) => 'unitId' in event && u.id === event.unitId,
      );
      expect(
        'owner' in event && event.owner,
        `${event.type} for ${'unitId' in event && event.unitId} names the wrong side`,
      ).toBe(named?.owner);
    }
  });
});

// --- determinism (spec §6) --------------------------------------------------

describe('resolve() — determinism', () => {
  /**
   * A round with every kind of outcome in it: a move, a standoff, a block, a
   * dropped order, a drone that sweeps and survives, a drone shot down
   * mid-flight, a missile that kills, and a missile that is intercepted.
   */
  function busyRound(): {
    state: GameState;
    p1: Order[];
    p2: Order[];
  } {
    const n = neighbors(CENTER);
    const far = offsetToAxial({ col: 4, row: 4 });
    const droneStart = offsetToAxial({ col: 15, row: 15 });
    const droneDest = north(droneStart, FLIGHT);
    const droneLane = hexLine(droneStart, droneDest);
    const spyStart = offsetToAxial({ col: 3, row: 15 });
    // A lane of its own on the west edge: 'v' fires north into 'shield'.
    const gunner = offsetToAxial({ col: 1, row: 8 });
    const shield = offsetToAxial({ col: 1, row: 10 });
    const state = openField([
      makeUnit('a', 'p1', 'launcher', n[0]),
      makeUnit('b', 'p1', 'launcher', far),
      // Fires at 'w', four hexes north and outside every bubble.
      makeUnit('c', 'p1', 'launcher', offsetToAxial({ col: 15, row: 18 })),
      makeUnit('eye', 'p1', 'drone', droneStart),
      makeUnit('shield', 'p1', 'interceptor', shield),
      makeUnit('z', 'p2', 'launcher', n[3]),
      makeUnit('y', 'p2', 'launcher', offsetToAxial({ col: 18, row: 4 })),
      makeUnit('v', 'p2', 'launcher', gunner),
      makeUnit('spy', 'p2', 'drone', spyStart),
      // Sits on p1's drone lane: 'eye' dies entering droneLane[2]...
      makeUnit('base', 'p2', 'interceptor', droneLane[3]),
      // ...but not before photographing this one, which 'c' then kills.
      makeUnit('w', 'p2', 'launcher', droneLane[1]),
    ]);
    return {
      state,
      p1: [
        move('a', CENTER),
        move('b', neighbors(far)[0]),
        launch('c', droneLane[1]),
        fly('eye', droneDest),
      ],
      p2: [
        move('z', CENTER),
        move('y', neighbors(offsetToAxial({ col: 18, row: 4 }))[0]),
        launch('v', north(gunner, -4)),
        fly('spy', north(spyStart, FLIGHT)),
      ],
    };
  }

  it('the fixture really does exercise every phase', () => {
    // Guards the tests below: if a refactor stopped downing the drone or
    // intercepting the missile, they would still pass while covering nothing.
    const { state, p1, p2 } = busyRound();
    const types = new Set(resolve(state, p1, p2, 0).events.map((e) => e.type));

    expect(types).toContain('DRONE_MOVED');
    expect(types).toContain('DRONE_DOWNED');
    expect(types).toContain('ASSET_SPOTTED');
    expect(types).toContain('LAUNCH_DETECTED');
    expect(types).toContain('MISSILE_INTERCEPTED');
    expect(types).toContain('IMPACT');
    expect(types).toContain('UNIT_DESTROYED');
    expect(types).toContain('UNIT_MOVED');
    expect(types).toContain('MOVE_FAILED');
  });

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

// --- phase 4: outcomes, dead hand, and the state machine (spec §3, §4, §5) --

describe('resolve() — phase 4 and the dead-hand round', () => {
  /** p2's bunker, already down to its last hit, and the launcher that answers. */
  const SITE = north(CENTER, 3);
  const P2_GUN = north(CENTER, 5);

  function hurtBunker(owner: PlayerId, hex: Hex): Unit {
    const bunker = makeUnit(`${owner}-bunker`, owner, 'bunker', hex);
    bunker.hp = 1; // took 1 of its 2 in an earlier round
    return bunker;
  }

  /** p1 is one missile from decapitating p2, who still has a launcher to answer with. */
  function onTheBrink(extra: Unit[] = []): GameState {
    return openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      hurtBunker('p2', SITE),
      makeUnit('z', 'p2', 'launcher', P2_GUN),
      ...extra,
    ]);
  }

  function typesOf(events: GameEvent[]): string[] {
    return events.map((e) => e.type);
  }

  it('a destroyed real bunker hands its owner the final round, not a loss', () => {
    const result = resolve(onTheBrink(), [launch('a', SITE)], NO_ORDERS, 0);

    expect(result.state.phase).toBe('DEAD_HAND_PHASE');
    expect(result.state.deadHandFor).toBe('p2');
    expect(result.state.outcome).toBeNull();
    expect(result.events.at(-1)).toEqual({
      type: 'DEAD_HAND_TRIGGERED',
      playerId: 'p2',
    });
  });

  it('the dead-hand round gets its own round number, so missile ids stay unique', () => {
    const result = resolve(onTheBrink(), [launch('a', SITE)], NO_ORDERS, 0);

    expect(result.state.round).toBe(2);
  });

  it('nobody moves in the round that triggers a dead hand (§3: phase 5 is skipped)', () => {
    const runner = north(CENTER, -4);
    const state = onTheBrink([makeUnit('b', 'p1', 'launcher', runner)]);

    const result = resolve(
      state,
      [launch('a', SITE), move('b', north(runner, 1))],
      NO_ORDERS,
      0,
    );

    expect(positionOf(result.state, 'b')).toEqual(runner);
    expect(typesOf(result.events)).not.toContain('UNIT_MOVED');
    expect(typesOf(result.events)).not.toContain('MOVE_FAILED');
  });

  it('destroying the DECOY triggers nothing at all (§12)', () => {
    const runner = north(CENTER, -4);
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('b', 'p1', 'launcher', runner),
      makeUnit('p2-decoy', 'p2', 'decoy', SITE),
      makeUnit('z', 'p2', 'launcher', P2_GUN),
    ]);

    const result = resolve(
      state,
      [launch('a', SITE), move('b', north(runner, 1))],
      NO_ORDERS,
      0,
    );

    expect(result.events).toContainEqual({
      type: 'UNIT_DESTROYED',
      unitId: 'p2-decoy',
      kind: 'decoy',
      hex: SITE,
    });
    expect(typesOf(result.events)).not.toContain('DEAD_HAND_TRIGGERED');
    expect(typesOf(result.events)).not.toContain('GAME_OVER');
    expect(result.state.phase).toBe('ORDER_PHASE');
    // The match continues, so phase 5 ran: the decoy cost the attacker a missile
    // and told them nothing except that they had found the fake.
    expect(positionOf(result.state, 'b')).toEqual(north(runner, 1));
  });

  it('skips the final round when the decapitated player has nothing left to fire', () => {
    const spent = makeUnit('z', 'p2', 'launcher', P2_GUN);
    spent.destroyed = true;
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      hurtBunker('p2', SITE),
      spent,
    ]);

    const result = resolve(state, [launch('a', SITE)], NO_ORDERS, 0);

    expect(typesOf(result.events)).not.toContain('DEAD_HAND_TRIGGERED');
    expect(result.state.phase).toBe('GAME_OVER');
    expect(result.state.outcome).toEqual({ type: 'DECAPITATION', winner: 'p1' });
  });

  it('both bunkers destroyed in one impact phase is a draw, with no final round', () => {
    const p1Site = north(CENTER, -1);
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      hurtBunker('p1', p1Site),
      hurtBunker('p2', SITE),
      makeUnit('z', 'p2', 'launcher', P2_GUN),
    ]);

    const result = resolve(state, [launch('a', SITE)], [launch('z', p1Site)], 0);

    expect(typesOf(result.events)).not.toContain('DEAD_HAND_TRIGGERED');
    expect(result.state.outcome).toEqual({ type: 'MUTUAL_ANNIHILATION' });
    expect(result.events.at(-1)).toEqual({
      type: 'GAME_OVER',
      outcome: { type: 'MUTUAL_ANNIHILATION' },
    });
  });

  // --- the final round itself ------------------------------------------------

  /** Play the decapitating round, and hand back the dead-hand state it produced. */
  function afterDecapitation(extra: Unit[] = []): GameState {
    return resolve(onTheBrink(extra), [launch('a', SITE)], NO_ORDERS, 0).state;
  }

  it('the retaliation lands, and the survivor wins by decapitation', () => {
    const deadHand = afterDecapitation();

    const result = resolve(deadHand, NO_ORDERS, [launch('z', CENTER)], 0);

    expect(unitOf(result.state, 'a').destroyed).toBe(true);
    expect(result.state.phase).toBe('GAME_OVER');
    // p1 lost their last launcher to the volley and still wins: bunker outcomes
    // outrank launcher outcomes (§4).
    expect(result.state.outcome).toEqual({ type: 'DECAPITATION', winner: 'p1' });
    expect(result.events.at(-1)).toEqual({
      type: 'GAME_OVER',
      outcome: { type: 'DECAPITATION', winner: 'p1' },
    });
  });

  it('runs phases 2 and 3 only — no recon, no movement (§3)', () => {
    const deadHand = afterDecapitation([
      makeUnit('p2-drone', 'p2', 'drone', north(CENTER, 6)),
    ]);

    const result = resolve(deadHand, NO_ORDERS, [launch('z', CENTER)], 0);

    expect(typesOf(result.events)).toEqual([
      'LAUNCH_DETECTED',
      'IMPACT',
      'UNIT_DESTROYED',
      'GAME_OVER',
    ]);
  });

  it('ignores the opponent’s orders entirely — they were never asked for any', () => {
    const deadHand = afterDecapitation();

    const result = resolve(deadHand, [launch('a', P2_GUN)], [launch('z', CENTER)], 0);

    // Exactly one missile flew, and it was not p1's.
    expect(result.events.filter((e) => e.type === 'LAUNCH_DETECTED')).toHaveLength(1);
    expect(unitOf(result.state, 'z').destroyed).toBe(false);
  });

  it('a dead-hand missile that answers in kind is mutual annihilation', () => {
    const p1Site = north(CENTER, -1);
    const deadHand = afterDecapitation([hurtBunker('p1', p1Site)]);

    const result = resolve(deadHand, NO_ORDERS, [launch('z', p1Site)], 0);

    expect(result.state.outcome).toEqual({ type: 'MUTUAL_ANNIHILATION' });
  });

  it('resolves the same dead-hand round identically twice (§6)', () => {
    const a = resolve(afterDecapitation(), NO_ORDERS, [launch('z', CENTER)], 7);
    const b = resolve(afterDecapitation(), NO_ORDERS, [launch('z', CENTER)], 999);

    expect(a.state).toEqual(b.state);
    expect(a.events).toEqual(b.events);
  });

  // --- the other ways a match ends -------------------------------------------

  it('losing your last launcher ends the match by disarmament, before movement', () => {
    const runner = north(CENTER, -4);
    const state = openField([
      makeUnit('a', 'p1', 'launcher', CENTER),
      makeUnit('b', 'p1', 'launcher', runner),
      makeUnit('z', 'p2', 'launcher', SITE),
    ]);

    const result = resolve(
      state,
      [launch('a', SITE), move('b', north(runner, 1))],
      NO_ORDERS,
      0,
    );

    expect(result.state.outcome).toEqual({ type: 'DISARMAMENT', winner: 'p1' });
    expect(positionOf(result.state, 'b')).toEqual(runner);
  });

  it('draws by armistice on the capped round', () => {
    const state = { ...openField([makeUnit('a', 'p1', 'launcher', CENTER)]), round: RULES.roundCap };

    const result = resolve(state, NO_ORDERS, NO_ORDERS, 0);

    expect(result.state.outcome).toEqual({ type: 'ARMISTICE' });
    expect(result.state.phase).toBe('GAME_OVER');
    // The round number stops where the match stopped, rather than counting on.
    expect(result.state.round).toBe(RULES.roundCap);
  });

  it('does not respawn a drone into a match that has just ended (§11)', () => {
    const downed = makeUnit('p2-drone', 'p2', 'drone', north(CENTER, 8));
    downed.destroyed = true;
    const state = {
      ...openField([
        makeUnit('a', 'p1', 'launcher', CENTER),
        makeUnit('z', 'p2', 'launcher', SITE),
        downed,
      ]),
      droneRespawnIn: { p1: 0, p2: 1 },
    };

    const result = resolve(state, [launch('a', SITE)], NO_ORDERS, 0);

    expect(result.state.outcome).toEqual({ type: 'DISARMAMENT', winner: 'p1' });
    expect(typesOf(result.events)).not.toContain('DRONE_RESPAWNED');
    expect(unitOf(result.state, 'p2-drone').destroyed).toBe(true);
    expect(result.state.droneRespawnIn.p2).toBe(1);
  });

  // --- illegal calls ---------------------------------------------------------

  it('throws when asked to resolve a finished match', () => {
    const over: GameState = {
      ...openField([makeUnit('a', 'p1', 'launcher', CENTER)]),
      phase: 'GAME_OVER',
      outcome: { type: 'ARMISTICE' },
    };

    expect(() => resolve(over, NO_ORDERS, NO_ORDERS, 0)).toThrow(/already over/);
  });

  it('throws when placement has not finished', () => {
    const setup: GameState = { ...openField([]), phase: 'SETUP' };

    expect(() => resolve(setup, NO_ORDERS, NO_ORDERS, 0)).toThrow(/startMatch/);
  });
});
