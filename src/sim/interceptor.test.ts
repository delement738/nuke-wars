// The interceptor redesign, end to end (spec §6, §10, §11 — added 2026-09-27).
//
// One base per player, coverage radius 2, hidden until it shoots down a MISSILE,
// then on the enemy's map for good. A dedicated file for the same reason as
// march.test.ts: the rule is one idea spread over three modules — the base that
// intercepted is recorded in `missiles.ts`, the reveal is filed in `resolve.ts`
// phase 2, and the event is routed in `visibility.ts`.
//
// The invariants worth naming, because each one is a mutation guard:
//
//   1. Intercepting a MISSILE exposes the base. Killing a DRONE does not — that
//      stays free and silent, and is the defender's quiet tool.
//   2. The reveal is filed on the ENEMY's map (`opponentOf(base.owner)`), never
//      the base owner's own (gotcha 21b's trap, pointed the other way).
//   3. `BASE_EXPOSED` fires once per base: a base already on the enemy's map
//      intercepts in silence.
//   4. It carries a hex and no unit id, and is emitted in ascending hex order —
//      it is public, so it is ordered by something already public (§9).

import { describe, expect, it } from 'vitest';
import { RULES, UNIT_DEFS } from './defs';
import { compareHex, distance, offsetToAxial, type Hex } from './hex';
import type { MapData, TileData } from './map';
import { resolve } from './resolve';
import type {
  GameEvent,
  GameState,
  Order,
  PlayerId,
  Unit,
  UnitKind,
} from './types';
import { filterEventsForPlayer, filterForPlayer } from './visibility';

// --- fixtures ---------------------------------------------------------------
// Synthetic all-plains board, same approach as march.test.ts: terrain is
// controlled rather than seed-dependent. Column-major fill for tileAt.

function makeMap(width = 21, height = 21): MapData {
  const tiles: TileData[] = [];
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < height; row++) {
      tiles.push({ col, row, terrain: 'plains' });
    }
  }
  return { width, height, tiles };
}

function makeUnit(id: string, owner: PlayerId, kind: UnitKind, position: Hex): Unit {
  return { id, owner, kind, position, hp: UNIT_DEFS[kind].hp, destroyed: false };
}

function makeState(units: Unit[]): GameState {
  return {
    round: 1,
    phase: 'ORDER_PHASE',
    map: makeMap(),
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

/** Offset coordinates read naturally here: same column, smaller row = north. */
function at(col: number, row: number): Hex {
  return offsetToAxial({ col, row });
}

function launch(unitId: string, target: Hex): Order {
  return { type: 'LAUNCH', unitId, target };
}

function fly(unitId: string, destination: Hex): Order {
  return { type: 'FLY', unitId, destination };
}

function exposures(events: readonly GameEvent[]) {
  return events.filter((e) => e.type === 'BASE_EXPOSED');
}

const R = RULES.interceptorCoverageRadius;

// p2's base sits in the north of column 10; p1's launcher fires up the column
// at a hex inside the bubble, so the missile is intercepted on its target hex.
const BASE = at(10, 8);
const GUNNER = at(10, 14);
const INTO_BUBBLE = at(10, 8 + R);

function lane(): GameState {
  return makeState([
    makeUnit('a', 'p1', 'launcher', GUNNER),
    makeUnit('base', 'p2', 'interceptor', BASE),
  ]);
}

// --- the rule ---------------------------------------------------------------

describe('interceptor bases — exposure on intercept (spec §10)', () => {
  it('the fixture puts the target inside the bubble and within missile range', () => {
    expect(distance(BASE, INTO_BUBBLE)).toBe(R);
    expect(distance(GUNNER, INTO_BUBBLE)).toBeLessThanOrEqual(RULES.missileRange);
  });

  it('the first missile it stops puts the base on the ENEMY’s map, permanently', () => {
    const result = resolve(lane(), [launch('a', INTO_BUBBLE)], [], 0);

    expect(exposures(result.events)).toEqual([
      { type: 'BASE_EXPOSED', owner: 'p2', hex: BASE },
    ]);
    expect(result.state.intel.p1.staticReveals).toEqual([
      { hex: BASE, kind: 'interceptor', round: 1 },
    ]);
    // Nothing a player does ever writes to their own intel (gotcha 21b).
    expect(result.state.intel.p2.staticReveals).toEqual([]);

    // Static, so permanent: a quiet round later it is still there.
    const later = resolve(result.state, [], [], 0);
    expect(later.state.intel.p1.staticReveals).toEqual([
      { hex: BASE, kind: 'interceptor', round: 1 },
    ]);
  });

  it('comes after the interception in the log, inside phase 2', () => {
    const types = resolve(lane(), [launch('a', INTO_BUBBLE)], [], 0).events.map(
      (e) => e.type,
    );

    expect(types).toEqual(['LAUNCH_DETECTED', 'MISSILE_INTERCEPTED', 'BASE_EXPOSED']);
  });

  it('fires once per base — a base already on the map intercepts in silence', () => {
    const first = resolve(lane(), [launch('a', INTO_BUBBLE)], [], 0);
    const second = resolve(first.state, [launch('a', INTO_BUBBLE)], [], 0);

    expect(second.events.map((e) => e.type)).toContain('MISSILE_INTERCEPTED');
    expect(exposures(second.events)).toEqual([]);
    // The reveal keeps the round it was first filed, like a re-photographed site.
    expect(second.state.intel.p1.staticReveals).toEqual([
      { hex: BASE, kind: 'interceptor', round: 1 },
    ]);
  });

  it('a drone kill does NOT expose the base — only a missile does', () => {
    const state = makeState([
      makeUnit('eye', 'p1', 'drone', GUNNER),
      makeUnit('base', 'p2', 'interceptor', BASE),
    ]);

    const result = resolve(state, [fly('eye', at(10, 14 - UNIT_DEFS.drone.movement))], [], 0);

    expect(result.events.map((e) => e.type)).toContain('DRONE_DOWNED');
    expect(exposures(result.events)).toEqual([]);
    // And the drone could not photograph it either (gotcha 20: swath < coverage).
    expect(result.state.intel.p1.staticReveals).toEqual([]);
  });

  it('a missile that misses every bubble exposes nothing', () => {
    const clear = at(10, 8 + R + 1);
    expect(distance(BASE, clear)).toBe(R + 1);

    const result = resolve(lane(), [launch('a', clear)], [], 0);

    expect(result.events.map((e) => e.type)).toEqual(['LAUNCH_DETECTED', 'IMPACT']);
    expect(result.state.intel.p1.staticReveals).toEqual([]);
  });

  it('a base broken by a saturating volley is exposed, then forgotten as it dies', () => {
    // Two missiles down the same lane: the first spends the base's one
    // intercept (and exposes it), the second lands on it (§10's saturation).
    const state = makeState([
      makeUnit('a', 'p1', 'launcher', GUNNER),
      makeUnit('b', 'p1', 'launcher', at(10, 13)),
      makeUnit('base', 'p2', 'interceptor', BASE),
    ]);

    const result = resolve(state, [launch('a', BASE), launch('b', BASE)], [], 0);

    expect(result.events.map((e) => e.type)).toEqual([
      'LAUNCH_DETECTED',
      'LAUNCH_DETECTED',
      'MISSILE_INTERCEPTED',
      'BASE_EXPOSED',
      'IMPACT',
      'UNIT_DESTROYED',
    ]);
    // UNIT_DESTROYED clears the marker (§11 rule 3); the kill stays in the log.
    expect(result.state.intel.p1.staticReveals).toEqual([]);
  });

  it('orders simultaneous exposures by HEX, not by units order or base id', () => {
    // Listed east-first, with the east base's id sorting first too, and the
    // east missile fired from close in so it is intercepted steps EARLIER than
    // the west one — so neither units order, id order nor interception order
    // could produce the west-first answer. Only the hex sort does.
    const west = at(4, 8);
    const east = at(16, 8);
    const state = makeState([
      makeUnit('base-a', 'p2', 'interceptor', east),
      makeUnit('base-b', 'p2', 'interceptor', west),
      makeUnit('e', 'p1', 'launcher', at(16, 9 + R)),
      makeUnit('w', 'p1', 'launcher', at(4, 14)),
    ]);
    expect(compareHex(west, east)).toBeLessThan(0);

    const result = resolve(
      state,
      [launch('e', at(16, 8 + R)), launch('w', at(4, 8 + R))],
      [],
      0,
    );

    expect(exposures(result.events)).toEqual([
      { type: 'BASE_EXPOSED', owner: 'p2', hex: west },
      { type: 'BASE_EXPOSED', owner: 'p2', hex: east },
    ]);
  });

  it('exposes both sides’ bases in the same round, each on the other’s map', () => {
    const p1Base = at(10, 16);
    const state = makeState([
      makeUnit('a', 'p1', 'launcher', GUNNER),
      makeUnit('base', 'p2', 'interceptor', BASE),
      makeUnit('z', 'p2', 'launcher', at(10, 10 + R)),
      makeUnit('home', 'p1', 'interceptor', p1Base),
    ]);

    const result = resolve(
      state,
      [launch('a', INTO_BUBBLE)],
      [launch('z', at(10, 16 - R))],
      0,
    );

    expect(result.state.intel.p1.staticReveals.map((r) => r.hex)).toEqual([BASE]);
    expect(result.state.intel.p2.staticReveals.map((r) => r.hex)).toEqual([p1Base]);
  });
});

// --- illegal orders ---------------------------------------------------------

describe('interceptor bases — rejected launches expose nothing', () => {
  it('a LAUNCH naming the ENEMY’s launcher, down the base’s lane, is silent', () => {
    // p1 names p2's launcher, aimed into p2's own bubble. Rejected in silence
    // (§10), so no missile ever flies and nothing can be intercepted.
    const state = makeState([
      makeUnit('a', 'p1', 'launcher', GUNNER),
      makeUnit('z', 'p2', 'launcher', at(10, 13)),
      makeUnit('base', 'p2', 'interceptor', BASE),
    ]);

    const result = resolve(state, [launch('z', INTO_BUBBLE)], [], 0);

    expect(result.events).toEqual([]);
    expect(result.state.intel.p1.staticReveals).toEqual([]);
  });

  it('an out-of-range LAUNCH at the base is silent too', () => {
    const tooFar = at(10, 14 - RULES.missileRange - 1);

    const result = resolve(lane(), [launch('a', tooFar)], [], 0);

    expect(result.events).toEqual([]);
    expect(result.state.intel.p1.staticReveals).toEqual([]);
  });
});

// --- visibility (spec §6) ---------------------------------------------------

describe('interceptor bases — who sees the exposure', () => {
  it('BASE_EXPOSED is public: the attacker learns the hex, the defender gets the warning', () => {
    const { events } = resolve(lane(), [launch('a', INTO_BUBBLE)], [], 0);

    for (const player of ['p1', 'p2'] as const) {
      expect(exposures(filterEventsForPlayer(events, player))).toEqual([
        { type: 'BASE_EXPOSED', owner: 'p2', hex: BASE },
      ]);
    }
  });

  it('the attacker’s filtered map shows an interceptor base on that hex', () => {
    const { state } = resolve(lane(), [launch('a', INTO_BUBBLE)], [], 0);

    expect(filterForPlayer(state, 'p1').intel.staticReveals).toEqual([
      { hex: BASE, kind: 'interceptor', round: 1 },
    ]);
    expect(filterForPlayer(state, 'p2').intel.staticReveals).toEqual([]);
  });

  it('carries no unit id — the hex is all the attacker’s map keys on', () => {
    const { events } = resolve(lane(), [launch('a', INTO_BUBBLE)], [], 0);

    for (const event of exposures(events)) {
      expect(Object.keys(event).sort()).toEqual(['hex', 'owner', 'type']);
    }
  });
});
