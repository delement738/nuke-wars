// Missile flight time, end to end (spec §3, §4, §10 — added 2026-09-27, V1.1
// Step 3).
//
// A missile advances `RULES.missileSpeed` hexes per round. A shot at range ≤ 4
// lands the round it is fired, exactly as before; a shot at 5–6 spends a round
// in flight — carried in `GameState.missiles`, visible to both players — and
// lands in the next round's phase 3. A dedicated file for the same reason as
// interceptor.test.ts: the rule is one idea spread over missiles.ts (the
// advance), resolve.ts (carrying and the dead-hand round), outcomes.ts (ruling
// 1) and visibility.ts (the public projection).
//
// The rulings each test below guards, as recorded in the spec:
//
//   1. A missile in the air is offensive capability: a side with none left on
//      the ground but one aloft is not disarmed.
//   2. A game-ending verdict freezes flights — they stay in state, never land.
//   3. The dead-hand round flies EVERY missile, both owners', to completion.
//   4. Cross-round tiebreak: oldest launch round first, then origin hex.
//   5. Fire-and-forget: the launcher dying does not touch its missile.

import { describe, expect, it } from 'vitest';
import { RULES, UNIT_DEFS } from './defs';
import { distance, offsetToAxial, type Hex } from './hex';
import type { MapData, TileData } from './map';
import { createMissile, missileIdFor } from './missiles';
import { resolve } from './resolve';
import type {
  GameEvent,
  GameState,
  Order,
  PlayerId,
  Unit,
  UnitKind,
} from './types';
import { filterForPlayer } from './visibility';

// --- fixtures ---------------------------------------------------------------
// Synthetic all-plains board, same approach as interceptor.test.ts. Every shot
// below runs straight up one column, where distance is just the row gap.

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

/** A bunker already down to its last hit, so one missile finishes it. */
function hurtBunker(owner: PlayerId, position: Hex): Unit {
  return { ...makeUnit(`${owner}-bunker`, owner, 'bunker', position), hp: 1 };
}

function makeState(units: Unit[], overrides: Partial<GameState> = {}): GameState {
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
    missiles: [],
    outcome: null,
    ...overrides,
  };
}

function at(col: number, row: number): Hex {
  return offsetToAxial({ col, row });
}

function launch(unitId: string, target: Hex): Order {
  return { type: 'LAUNCH', unitId, target };
}

function typesOf(events: readonly GameEvent[]): string[] {
  return events.map((e) => e.type);
}

function unitOf(state: GameState, id: string): Unit {
  const unit = state.units.find((u) => u.id === id);
  if (!unit) throw new Error(`no unit ${id}`);
  return unit;
}

const SPEED = RULES.missileSpeed;
const RANGE = RULES.missileRange;

// A range-6 lane up column 10.
const LONG_GUN = at(10, 16);
const LONG_TARGET = at(10, 10);

/** A p2 launcher far from every lane, so killing 'z' is not a disarmament. */
const SPARE = makeUnit('spare', 'p2', 'launcher', at(2, 2));

// --- the rule ---------------------------------------------------------------

describe('missile flight time (spec §10)', () => {
  it('the fixtures mean what they claim', () => {
    expect(SPEED).toBe(4);
    expect(RANGE).toBe(6);
    expect(distance(LONG_GUN, LONG_TARGET)).toBe(RANGE);
  });

  it('a range-6 shot is detected in round N, flies, and lands in round N+1', () => {
    const state = makeState([
      makeUnit('a', 'p1', 'launcher', LONG_GUN),
      makeUnit('z', 'p2', 'launcher', LONG_TARGET),
      SPARE,
    ]);

    const first = resolve(state, [launch('a', LONG_TARGET)], [], 0);

    expect(typesOf(first.events)).toEqual(['LAUNCH_DETECTED']);
    expect(unitOf(first.state, 'z').destroyed).toBe(false);
    expect(first.state.missiles).toHaveLength(1);
    expect(first.state.missiles[0]).toMatchObject({
      id: missileIdFor(1, LONG_GUN),
      owner: 'p1',
      launchRound: 1,
      traveled: SPEED,
    });

    // Round 2: no orders from anyone, and the missile still lands. It was
    // announced in round 1, so it does not get a second LAUNCH_DETECTED.
    const second = resolve(first.state, [], [], 0);

    expect(typesOf(second.events)).toEqual(['IMPACT', 'UNIT_DESTROYED']);
    expect(second.events[0]).toEqual({
      type: 'IMPACT',
      missileId: first.state.missiles[0].id,
      hex: LONG_TARGET,
    });
    expect(second.state.missiles).toEqual([]);
  });

  it('a range-4 shot lands the round it is fired, as before flight time', () => {
    const gun = at(10, 14);
    expect(distance(gun, LONG_TARGET)).toBe(SPEED);
    const state = makeState([
      makeUnit('a', 'p1', 'launcher', gun),
      makeUnit('z', 'p2', 'launcher', LONG_TARGET),
      SPARE,
    ]);

    const result = resolve(state, [launch('a', LONG_TARGET)], [], 0);

    expect(typesOf(result.events)).toEqual([
      'LAUNCH_DETECTED',
      'IMPACT',
      'UNIT_DESTROYED',
    ]);
    expect(result.state.missiles).toEqual([]);
  });

  it('is deterministic with missiles in flight', () => {
    const state = makeState([
      makeUnit('a', 'p1', 'launcher', LONG_GUN),
      makeUnit('b', 'p1', 'launcher', at(12, 16)),
      makeUnit('z', 'p2', 'launcher', LONG_TARGET),
    ]);
    const orders = [launch('a', LONG_TARGET), launch('b', at(12, 10))];
    const first = resolve(state, orders, [], 0).state;

    const a = resolve(first, [], [], 0);
    const b = resolve(structuredClone(first), [], [], 0);

    expect(a).toEqual(b);
    // Order of submission is irrelevant too (§6).
    expect(resolve(state, [...orders].reverse(), [], 0)).toEqual(
      resolve(state, orders, [], 0),
    );
  });

  it('an illegal LAUNCH puts nothing in the air', () => {
    const state = makeState([makeUnit('a', 'p1', 'launcher', LONG_GUN)]);

    const result = resolve(state, [launch('a', at(10, 16 - RANGE - 1))], [], 0);

    expect(result.events).toEqual([]);
    expect(result.state.missiles).toEqual([]);
  });
});

// --- interception across two rounds -----------------------------------------

describe('flight time and interception (spec §10)', () => {
  const BASE = at(10, 8); // covers rows 6–10 of the column at radius 2

  it('an interception in the missile’s SECOND round still exposes the base', () => {
    const state = makeState([
      makeUnit('a', 'p1', 'launcher', LONG_GUN),
      makeUnit('base', 'p2', 'interceptor', BASE),
    ]);

    const first = resolve(state, [launch('a', LONG_TARGET)], [], 0);
    expect(typesOf(first.events)).toEqual(['LAUNCH_DETECTED']);

    const second = resolve(first.state, [], [], 0);

    expect(typesOf(second.events)).toEqual(['MISSILE_INTERCEPTED', 'BASE_EXPOSED']);
    expect(second.state.intel.p1.staticReveals).toEqual([
      { hex: BASE, kind: 'interceptor', round: 2 },
    ]);
    expect(second.state.missiles).toEqual([]);
  });

  it('checks each hex once, on entry — a missile parked in a bubble is not re-engaged there', () => {
    // Carried in with 4 hexes flown: it is sitting on row 12, which a base at
    // row 14 covers. Its remaining hexes (rows 11 and 10) are outside the
    // bubble, so the only way it can be stopped is by a re-check of the hex it
    // already entered last round.
    const base = at(10, 14);
    const launcher = makeUnit('a', 'p1', 'launcher', LONG_GUN);
    const parked = { ...createMissile(1, launcher, LONG_TARGET), traveled: SPEED };
    expect(distance(parked.path[SPEED - 1], base)).toBeLessThanOrEqual(
      RULES.interceptorCoverageRadius,
    );
    const state = makeState(
      [launcher, makeUnit('base', 'p2', 'interceptor', base)],
      { round: 2, missiles: [parked] },
    );

    const result = resolve(state, [], [], 0);

    expect(typesOf(result.events)).toEqual(['IMPACT']);
  });

  it('capacity resets each round: one base stops a missile in consecutive rounds', () => {
    // 'short' is caught in round 1. 'long' reaches the bubble only in round 2,
    // when the base has its intercept back. Capacity is per ROUND, not per
    // missile's lifetime — and the base is exposed only once.
    const state = makeState([
      makeUnit('short', 'p1', 'launcher', at(10, 12)),
      makeUnit('long', 'p1', 'launcher', LONG_GUN),
      makeUnit('base', 'p2', 'interceptor', BASE),
    ]);

    const first = resolve(
      state,
      [launch('short', LONG_TARGET), launch('long', LONG_TARGET)],
      [],
      0,
    );
    expect(typesOf(first.events)).toEqual([
      'LAUNCH_DETECTED',
      'LAUNCH_DETECTED',
      'MISSILE_INTERCEPTED',
      'BASE_EXPOSED',
    ]);
    expect(first.state.missiles).toHaveLength(1);

    const second = resolve(first.state, [], [], 0);
    expect(typesOf(second.events)).toEqual(['MISSILE_INTERCEPTED']);
  });
});

// --- ruling 5 and ruling 1 ---------------------------------------------------

describe('fire-and-forget, and a missile aloft is not disarmament (§4)', () => {
  it('lands after its launcher dies, and only then is its owner disarmed', () => {
    // p1's only launcher fires long at 'z', and is itself killed the same round
    // by p2's short counter-shot. p1 has zero launchers — but a missile in the
    // air, so the match goes on. Round 2 it lands; now p1 has nothing, and p2
    // (still holding 'y') wins by disarmament.
    const state = makeState([
      makeUnit('a', 'p1', 'launcher', LONG_GUN),
      makeUnit('z', 'p2', 'launcher', LONG_TARGET),
      makeUnit('y', 'p2', 'launcher', at(10, 19)),
    ]);

    const first = resolve(state, [launch('a', LONG_TARGET)], [launch('y', LONG_GUN)], 0);

    expect(unitOf(first.state, 'a').destroyed).toBe(true);
    expect(first.state.outcome).toBeNull();
    expect(first.state.phase).toBe('ORDER_PHASE');
    expect(first.state.missiles.map((m) => m.owner)).toEqual(['p1']);

    const second = resolve(first.state, [], [], 0);

    expect(unitOf(second.state, 'z').destroyed).toBe(true);
    expect(second.state.outcome).toEqual({ type: 'DISARMAMENT', winner: 'p2' });
  });
});

// --- rulings 2 and 3: the end of the match ----------------------------------

describe('flights and the end of the match (§3)', () => {
  it('a game-ending verdict freezes missiles in the air — they never land', () => {
    // p2 has no living launcher, so decapitating them is final with no dead-hand
    // round. p1's long shot fired the same round is still aloft: it stays in
    // state, and nothing follows GAME_OVER.
    const state = makeState([
      makeUnit('a', 'p1', 'launcher', at(10, 13)),
      makeUnit('b', 'p1', 'launcher', at(10, 20)),
      hurtBunker('p2', LONG_TARGET),
      { ...makeUnit('z', 'p2', 'launcher', at(4, 4)), hp: 0, destroyed: true },
    ]);

    const result = resolve(
      state,
      [launch('a', LONG_TARGET), launch('b', at(10, 14))],
      [],
      0,
    );

    expect(result.state.outcome).toEqual({ type: 'DECAPITATION', winner: 'p1' });
    expect(result.state.missiles).toHaveLength(1);
    expect(result.events.at(-1)?.type).toBe('GAME_OVER');
    expect(typesOf(result.events).filter((t) => t === 'IMPACT')).toHaveLength(1);
  });

  it('an enemy missile still inbound during dead hand turns decapitation into mutual annihilation', () => {
    // Round 1: p2 fires long at p1's bunker; p1 fires short and kills p2's.
    // Dead hand triggers for p2 — who then orders NOTHING, yet the missile they
    // fired before losing their bunker is flown in by the dead-hand round.
    const state = makeState([
      makeUnit('a', 'p1', 'launcher', LONG_GUN),
      hurtBunker('p1', at(10, 4)),
      hurtBunker('p2', at(10, 13)),
      makeUnit('z', 'p2', 'launcher', LONG_TARGET),
    ]);

    const first = resolve(state, [launch('a', at(10, 13))], [launch('z', at(10, 4))], 0);

    expect(first.state.phase).toBe('DEAD_HAND_PHASE');
    expect(first.state.missiles.map((m) => m.owner)).toEqual(['p2']);

    const final = resolve(first.state, [], [], 0);

    expect(final.state.outcome).toEqual({ type: 'MUTUAL_ANNIHILATION' });
    expect(final.state.missiles).toEqual([]);
  });

  it('a range-6 dead-hand retaliation is flown to completion and lands', () => {
    const state = makeState([
      makeUnit('a', 'p1', 'launcher', LONG_GUN),
      hurtBunker('p1', at(10, 4)),
      hurtBunker('p2', at(10, 13)),
      makeUnit('z', 'p2', 'launcher', LONG_TARGET),
    ]);
    const deadHand = resolve(state, [launch('a', at(10, 13))], [], 0).state;
    expect(deadHand.phase).toBe('DEAD_HAND_PHASE');

    const final = resolve(deadHand, [], [launch('z', at(10, 4))], 0);

    expect(typesOf(final.events)).toEqual([
      'LAUNCH_DETECTED',
      'IMPACT',
      'UNIT_DESTROYED',
      'GAME_OVER',
    ]);
    expect(final.state.outcome).toEqual({ type: 'MUTUAL_ANNIHILATION' });
    expect(final.state.missiles).toEqual([]);
  });

  it('dead-hand passes reset capacity: a base can stop one missile per pass', () => {
    // Two range-6 retaliations up one lane toward a p1 base. Pass 1 flies both
    // four hexes, and the base (covering the last two hexes) sees neither.
    // Pass 2: the base has one intercept, so exactly one lands — the same
    // saturation rule a normal round has.
    const p1Base = at(10, 3);
    const state = makeState([
      makeUnit('a', 'p1', 'launcher', LONG_GUN),
      hurtBunker('p1', at(4, 4)),
      makeUnit('base', 'p1', 'interceptor', p1Base),
      hurtBunker('p2', at(10, 13)),
      makeUnit('z', 'p2', 'launcher', LONG_TARGET),
      makeUnit('y', 'p2', 'launcher', at(10, 11)),
    ]);
    const deadHand = resolve(state, [launch('a', at(10, 13))], [], 0).state;

    const final = resolve(
      deadHand,
      [],
      [launch('z', at(10, 4)), launch('y', at(10, 5))],
      0,
    );

    const types = typesOf(final.events);
    expect(types.filter((t) => t === 'MISSILE_INTERCEPTED')).toHaveLength(1);
    expect(types.filter((t) => t === 'IMPACT')).toHaveLength(1);
    expect(final.state.missiles).toEqual([]);
  });
});

// --- visibility (§6) ---------------------------------------------------------

describe('missiles in the filtered state (§6)', () => {
  it('both players see every flight, with no launcher identity on it', () => {
    const state = makeState([
      makeUnit('a', 'p1', 'launcher', LONG_GUN),
      makeUnit('z', 'p2', 'launcher', LONG_TARGET),
    ]);
    const flying = resolve(state, [launch('a', LONG_TARGET)], [], 0).state;

    for (const viewer of ['p1', 'p2'] as const) {
      const [seen] = filterForPlayer(flying, viewer).missiles;
      expect(seen).toEqual({
        id: flying.missiles[0].id,
        owner: 'p1',
        origin: LONG_GUN,
        target: LONG_TARGET,
        launchRound: 1,
        traveled: SPEED,
      });
      // Structural redaction: the key is not there at all, not merely empty.
      expect(Object.keys(seen)).not.toContain('launcherId');
      expect(JSON.stringify(seen)).not.toContain('"a"');
    }
  });
});
