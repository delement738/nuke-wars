import { describe, expect, it } from 'vitest';
import { RULES, SPAWNS, UNIT_DEFS } from '../sim/defs';
import {
  axialToOffset,
  distance,
  hexKey,
  hexLine,
  offsetToAxial,
  type Hex,
} from '../sim/hex';
import { generateMap, makeRng, type MapData, type TileData } from '../sim/map';
import { validateLaunch as validateLaunchOrder } from '../sim/missiles';
import { reachableHexes, validateMove } from '../sim/movement';
import { reconSwath, validateFly } from '../sim/recon';
import { startMatch, type PlayerSetup } from '../sim/setup';
import {
  opponentOf,
  PLAYERS,
  type GameState,
  type LauncherContact,
  type Order,
  type PlayerId,
  type Unit,
  type UnitKind,
  type VisibleGameState,
  type VisiblePlayerIntel,
  type VisibleStaticReveal,
} from '../sim/types';
import { filterForPlayer } from '../sim/visibility';
import {
  cpuOrders,
  nextSweepWaypoint,
  pickAdvanceDestination,
  SAFETY_DETOUR_TOLERANCE,
  selectTarget,
  sweepLanes,
  type AdvanceGoal,
  type CpuDifficulty,
} from './cpu';
import { sandboxSetup } from './sandbox';

const DIFFICULTIES: readonly CpuDifficulty[] = ['easy', 'medium', 'hard'];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An all-plains board the real size of a match map, so hand-placed units and
 * targets stay comfortably on-map without fighting terrain generation. */
function plainsMap(width = 16, height = 19): MapData {
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

function makeView(
  map: MapData,
  units: readonly Unit[],
  intel: Partial<VisiblePlayerIntel> = {},
  overrides: Partial<VisibleGameState> = {},
): VisibleGameState {
  return {
    round: 1,
    phase: 'ORDER_PHASE',
    map,
    units: [...units],
    intel: { staticReveals: [], contacts: [], ...intel },
    droneRespawnIn: 0,
    deadHandFor: null,
    outcome: null,
    ...overrides,
  };
}

function contact(hex: Hex): LauncherContact {
  return { hex, source: 'LAUNCH' };
}

/** The `GameState`-shaped board `cpu.ts` builds internally from a view, so a
 * test can ask the real `reachableHexes` what was actually on offer. */
function believedStateFor(map: MapData, units: readonly Unit[]): GameState {
  return {
    round: 1,
    phase: 'ORDER_PHASE',
    map,
    units: [...units],
    intel: {
      p1: { staticReveals: [], contacts: [] },
      p2: { staticReveals: [], contacts: [] },
    },
    droneRespawnIn: { p1: 0, p2: 0 },
    deadHandFor: null,
    outcome: null,
  };
}

function staticReveal(hex: Hex): VisibleStaticReveal {
  return { hex, kind: 'bunker', round: 1 };
}

/**
 * Two legal secret setups on `map`, drawn from one seeded stream.
 *
 * One stream consumed in turn, never two streams from the same seed — that
 * would make each side's setup a deterministic function of the other's (see
 * `sandboxSetup`). Seeded, so every test below stays reproducible.
 */
function fixtureSetups(map: MapData, seed: number): Record<PlayerId, PlayerSetup> {
  const rng = makeRng(seed);
  return { p1: sandboxSetup(map, 'p1', rng), p2: sandboxSetup(map, 'p2', rng) };
}

/** A real, freshly-started match's redacted view for `player` — the broad
 * legality/determinism checks run against this rather than a hand fixture, so
 * they exercise the real setup/spawn geometry too. */
function realView(seed: number, player: PlayerId): { view: VisibleGameState; map: MapData } {
  const map = generateMap(undefined, undefined, seed);
  const state = startMatch(map, fixtureSetups(map, seed));
  return { view: filterForPlayer(state, player), map };
}

// ---------------------------------------------------------------------------
// Broad invariants, all three difficulties, real matches
// ---------------------------------------------------------------------------

describe('cpuOrders — invariants that hold for every difficulty', () => {
  const seeds = [1, 42, 137, 5000];

  it('never issues two orders for the same unit (RULES.ordersPerUnit)', () => {
    for (const seed of seeds) {
      for (const player of PLAYERS) {
        for (const difficulty of DIFFICULTIES) {
          const { view } = realView(seed, player);
          const orders = cpuOrders(view, difficulty, player, makeRng(seed));
          const unitIds = orders.map((o) => o.unitId);
          expect(new Set(unitIds).size).toBe(unitIds.length);
        }
      }
    }
  });

  it('every proposed order is legal against the TRUE state at match start', () => {
    // At round 1 nothing is hidden yet — no combat has happened, so the CPU's
    // belief and the engine's truth agree for its own units. This is the
    // strongest legality check available: not just "self-consistent with its
    // own belief" but "the real engine accepts it".
    for (const seed of seeds) {
      for (const player of PLAYERS) {
        for (const difficulty of DIFFICULTIES) {
          const map = generateMap(undefined, undefined, seed);
          const truth = startMatch(map, fixtureSetups(map, seed));
          const view = filterForPlayer(truth, player);

          for (const order of cpuOrders(view, difficulty, player, makeRng(seed))) {
            if (order.type === 'MOVE') {
              expect(validateMove(truth, player, order)).toMatchObject({ legal: true });
            } else if (order.type === 'LAUNCH') {
              expect(validateLaunchOrder(truth, player, order)).toMatchObject({ legal: true });
            } else {
              expect(validateFly(truth, player, order)).toMatchObject({ legal: true });
            }
          }
        }
      }
    }
  });

  it('is deterministic — the same view, difficulty and seeded rng reproduce the same orders', () => {
    for (const seed of seeds) {
      for (const player of PLAYERS) {
        for (const difficulty of DIFFICULTIES) {
          const { view } = realView(seed, player);
          const first = cpuOrders(view, difficulty, player, makeRng(seed + 1));
          const second = cpuOrders(view, difficulty, player, makeRng(seed + 1));
          expect(second).toEqual(first);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// EASY — passive, intel-blind
// ---------------------------------------------------------------------------

describe('EASY', () => {
  it('issues noticeably fewer orders than MEDIUM over many rounds (statistical)', () => {
    const { view } = realView(42, 'p1');
    let easyTotal = 0;
    let mediumTotal = 0;
    for (let seed = 0; seed < 300; seed++) {
      easyTotal += cpuOrders(view, 'easy', 'p1', makeRng(seed)).length;
      mediumTotal += cpuOrders(view, 'medium', 'p1', makeRng(seed)).length;
    }
    // MEDIUM always tries to act (fire or advance) for every living orderable
    // unit on an empty board; EASY holds/hovers most of the time by design
    // (spec: EASY_HOLD_CHANCE/EASY_HOVER_CHANCE). The gap should be large, not
    // a coin flip either way.
    expect(easyTotal).toBeLessThan(mediumTotal * 0.6);
  });
});

// ---------------------------------------------------------------------------
// MEDIUM vs HARD — target selection
// ---------------------------------------------------------------------------

describe('selectTarget', () => {
  const from: Hex = { q: 0, r: 0 };
  // Kind-neutral on purpose: `selectTarget` knows nothing about contacts or
  // sites, only about the priority number `knownTargets` stamped on them, so
  // these stay correct if that mapping is ever retuned again.
  const nearLowRank = { hex: { q: 2, r: 0 }, priority: 1 }; // lower-priority, closer hex
  const farHighRank = { hex: { q: 4, r: 0 }, priority: 0 }; // higher-priority, farther hex

  it('unranked (MEDIUM): picks the nearest candidate, kind-blind', () => {
    expect(selectTarget([nearLowRank, farHighRank], from, false)).toEqual(nearLowRank);
  });

  it('ranked (HARD): picks the higher-priority candidate even though it is farther', () => {
    expect(selectTarget([nearLowRank, farHighRank], from, true)).toEqual(farHighRank);
  });

  it('returns undefined with no candidates', () => {
    expect(selectTarget([], from, true)).toBeUndefined();
  });
});

describe('cpuOrders — target priority wired end to end', () => {
  const player: PlayerId = 'p1';
  const map = plainsMap();
  const launcherPos = offsetToAxial({ col: 8, row: 10 });
  // The site is deliberately the FARTHER of the two, so the two tiers cannot
  // agree by accident: distance alone and priority alone give different answers.
  const closeContact = contact(offsetToAxial({ col: 8, row: 8 })); // distance 2
  const farReveal = staticReveal(offsetToAxial({ col: 8, row: 6 })); // distance 4, <= range 6

  function fixtureView(): VisibleGameState {
    const launcher = makeUnit('L1', player, 'launcher', launcherPos);
    return makeView(map, [launcher], {
      staticReveals: [farReveal],
      contacts: [closeContact],
    });
  }

  it('MEDIUM fires at the nearer known target regardless of kind', () => {
    const orders = cpuOrders(fixtureView(), 'medium', player, () => 0);
    expect(orders).toEqual<Order[]>([
      { type: 'LAUNCH', unitId: 'L1', target: closeContact.hex },
    ]);
  });

  it('HARD fires at the farther bunker site over the nearer launcher contact', () => {
    // The tier's defining choice: it gives up a certain kill for a shot at the
    // win condition. See `knownTargets` in cpu.ts for why, and for the soak
    // measurement that settled it.
    const orders = cpuOrders(fixtureView(), 'hard', player, () => 0);
    expect(orders).toEqual<Order[]>([
      { type: 'LAUNCH', unitId: 'L1', target: farReveal.hex },
    ]);
  });
});

// ---------------------------------------------------------------------------
// HARD — movement safety
// ---------------------------------------------------------------------------

describe('pickAdvanceDestination', () => {
  const player: PlayerId = 'p1';
  const map = plainsMap();
  const start = offsetToAxial({ col: 8, row: 10 });
  const launcher = makeUnit('L1', player, 'launcher', start);
  const believed = {
    round: 1,
    phase: 'ORDER_PHASE' as const,
    map,
    units: [launcher],
    intel: { p1: { staticReveals: [], contacts: [] }, p2: { staticReveals: [], contacts: [] } },
    droneRespawnIn: { p1: 0, p2: 0 },
    deadHandFor: null,
    outcome: null,
  };
  const targetRow = 5; // matches RULES.homeZoneRows.p2.max, p1's advance target
  const goal: AdvanceGoal = { kind: 'row', row: targetRow };

  function scoredReachable() {
    return [...reachableHexes(believed, launcher).values()]
      .map((r) => r.hex)
      .filter((hex) => hexKey(hex) !== hexKey(start))
      .map((hex) => ({ hex, score: Math.abs(axialToOffset(hex).row - targetRow) }))
      .sort((a, b) => a.score - b.score);
  }

  it('picks the most-advanced reachable hex when nothing is dangerous', () => {
    const scored = scoredReachable();
    const destination = pickAdvanceDestination(believed, launcher, goal, new Set(), null);
    expect(destination).not.toBeNull();
    expect(Math.abs(axialToOffset(destination!).row - targetRow)).toBe(scored[0].score);
  });

  it('trades a small detour for safety when the single best hex is dangerous', () => {
    const scored = scoredReachable();
    const best = scored[0];
    // Sanity: an unobstructed radius-3 disc has hexes at consecutive scores,
    // so a hex exactly one worse than the best should exist.
    const secondBest = scored.find((c) => c.score === best.score + SAFETY_DETOUR_TOLERANCE);
    expect(secondBest).toBeDefined();

    const danger = new Set([hexKey(best.hex)]);
    const destination = pickAdvanceDestination(believed, launcher, goal, new Set(), danger);

    expect(destination).not.toBeNull();
    expect(hexKey(destination!)).not.toBe(hexKey(best.hex));
    expect(Math.abs(axialToOffset(destination!).row - targetRow)).toBeLessThanOrEqual(
      best.score + SAFETY_DETOUR_TOLERANCE,
    );
  });

  it('never returns a hex in `avoid`, even if it is the only progress available', () => {
    const scored = scoredReachable();
    const avoid = new Set(scored.map((c) => hexKey(c.hex)));
    expect(pickAdvanceDestination(believed, launcher, goal, avoid, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  const player: PlayerId = 'p1';
  const map = plainsMap();

  it('no living launchers: proposes no MOVE/LAUNCH orders', () => {
    const drone = makeUnit('D1', player, 'drone', offsetToAxial({ col: 8, row: 10 }));
    const view = makeView(map, [drone]);
    for (const difficulty of DIFFICULTIES) {
      const orders = cpuOrders(view, difficulty, player, () => 0);
      expect(orders.every((o) => o.type === 'FLY')).toBe(true);
    }
  });

  it('drone respawning (droneRespawnIn > 0): never proposes FLY, even if a drone unit is present', () => {
    const drone: Unit = {
      ...makeUnit('D1', player, 'drone', offsetToAxial({ col: 8, row: 17 })),
      destroyed: true,
    };
    const launcher = makeUnit('L1', player, 'launcher', offsetToAxial({ col: 8, row: 10 }));
    const view = makeView(map, [launcher, drone], {}, { droneRespawnIn: 1 });
    for (const difficulty of DIFFICULTIES) {
      const orders = cpuOrders(view, difficulty, player, () => 0);
      expect(orders.some((o) => o.type === 'FLY')).toBe(false);
    }
  });

  it('dead hand: only the decapitated player gets orders, and only LAUNCH ones', () => {
    const launcher = makeUnit('L1', player, 'launcher', offsetToAxial({ col: 8, row: 10 }));
    const drone = makeUnit('D1', player, 'drone', offsetToAxial({ col: 8, row: 11 }));
    const view = makeView(
      map,
      [launcher, drone],
      {},
      { phase: 'DEAD_HAND_PHASE', deadHandFor: player },
    );
    for (const difficulty of DIFFICULTIES) {
      const orders = cpuOrders(view, difficulty, player, () => 0);
      expect(orders.length).toBeGreaterThan(0);
      expect(orders.every((o) => o.type === 'LAUNCH')).toBe(true);
    }
  });

  it("dead hand: the player who is NOT deadHandFor submits nothing (spec §3 — 'the opponent issues no orders at all')", () => {
    const launcher = makeUnit('L1', player, 'launcher', offsetToAxial({ col: 8, row: 10 }));
    const view = makeView(
      map,
      [launcher],
      {},
      { phase: 'DEAD_HAND_PHASE', deadHandFor: opponentOf(player) },
    );
    for (const difficulty of DIFFICULTIES) {
      expect(cpuOrders(view, difficulty, player, () => 0)).toEqual([]);
    }
  });

  it('dead hand: targets a known bunker/decoy site, never a launcher contact — a contact cannot change the verdict (outcomes.ts)', () => {
    const launcherPos = offsetToAxial({ col: 8, row: 10 });
    const launcher = makeUnit('L1', player, 'launcher', launcherPos);
    const site = staticReveal(offsetToAxial({ col: 8, row: 8 })); // distance 2
    const enemyContact = contact(offsetToAxial({ col: 8, row: 9 })); // distance 1, closer
    const view = makeView(
      map,
      [launcher],
      { staticReveals: [site], contacts: [enemyContact] },
      { phase: 'DEAD_HAND_PHASE', deadHandFor: player },
    );

    for (const difficulty of DIFFICULTIES) {
      const orders = cpuOrders(view, difficulty, player, () => 0);
      expect(orders).toEqual<Order[]>([{ type: 'LAUNCH', unitId: 'L1', target: site.hex }]);
    }
  });

  it('never submits an illegal LAUNCH at the launcher\'s own hex, even from degenerate intel', () => {
    // A hand-built fixture no real game state could produce: intel claims a
    // "site" sits exactly on the CPU's own launcher. validateLaunch rejects
    // this as SAME_HEX, and cpuOrders must fall through to movement rather
    // than submit the illegal order — this is the defense-in-depth check
    // every proposed order gets before it leaves cpu.ts.
    const pos = offsetToAxial({ col: 8, row: 10 });
    const launcher = makeUnit('L1', player, 'launcher', pos);
    const view = makeView(map, [launcher], { staticReveals: [staticReveal(pos)] });

    for (const difficulty of DIFFICULTIES) {
      const orders = cpuOrders(view, difficulty, player, () => 0.5);
      const launch = orders.find((o) => o.type === 'LAUNCH');
      expect(launch).toBeUndefined();
      // Whatever it did instead must itself be legal against the true state.
      for (const order of orders) {
        if (order.type === 'MOVE') {
          const believed = {
            round: 1,
            phase: 'ORDER_PHASE' as const,
            map,
            units: [launcher],
            intel: { p1: { staticReveals: [], contacts: [] }, p2: { staticReveals: [], contacts: [] } },
            droneRespawnIn: { p1: 0, p2: 0 },
            deadHandFor: null,
            outcome: null,
          };
          expect(validateMove(believed, player, order)).toMatchObject({ legal: true });
        }
      }
    }
  });

  it('empty board (no launchers, no drone): returns no orders without throwing', () => {
    const view = makeView(map, []);
    for (const difficulty of DIFFICULTIES) {
      expect(() => cpuOrders(view, difficulty, player, () => 0)).not.toThrow();
      expect(cpuOrders(view, difficulty, player, () => 0)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The recon sweep (medium & hard)
// ---------------------------------------------------------------------------

describe('sweepLanes', () => {
  const map = plainsMap();

  it('keeps every waypoint inside the opponent home zone and on the map', () => {
    for (const player of PLAYERS) {
      const zone = RULES.homeZoneRows[opponentOf(player)];
      for (const lane of sweepLanes(player, map.width)) {
        const { col, row } = axialToOffset(lane);
        expect(row).toBeGreaterThanOrEqual(zone.min);
        expect(row).toBeLessThanOrEqual(zone.max);
        expect(col).toBeGreaterThanOrEqual(0);
        expect(col).toBeLessThan(map.width);
      }
    }
  });

  it('spaces consecutive waypoints within a single flight', () => {
    // Load-bearing: a hop longer than the drone's range takes more than one
    // round, so the tour stalls and `nextSweepWaypoint` never advances past it.
    for (const player of PLAYERS) {
      const lanes = sweepLanes(player, map.width);
      expect(lanes.length).toBeGreaterThan(1);
      for (let i = 1; i < lanes.length; i++) {
        expect(distance(lanes[i - 1], lanes[i])).toBeLessThanOrEqual(UNIT_DEFS.drone.movement);
      }
    }
  });

  it('photographs the ENTIRE opponent home zone when the tour is walked', () => {
    // The reason the tour exists. Asserting coverage rather than lane positions
    // means a future retune of the swath radius, the drone range or the home
    // zone either still covers the zone or fails right here.
    for (const player of PLAYERS) {
      const lanes = sweepLanes(player, map.width);
      const seen = new Set<string>();
      for (let i = 1; i < lanes.length; i++) {
        for (const key of reconSwath(hexLine(lanes[i - 1], lanes[i]))) seen.add(key);
      }

      const zone = RULES.homeZoneRows[opponentOf(player)];
      for (let col = 0; col < map.width; col++) {
        for (let row = zone.min; row <= zone.max; row++) {
          expect(seen.has(hexKey(offsetToAxial({ col, row })))).toBe(true);
        }
      }
    }
  });

  it('starts the tour at the edge of the zone the drone arrives from', () => {
    // p1 comes from the south (high rows) so it sweeps p2's southern strip
    // first, and vice versa — otherwise the drone crosses the whole zone
    // unphotographed before starting work.
    expect(axialToOffset(sweepLanes('p1', map.width)[0]).row).toBeGreaterThan(
      axialToOffset(sweepLanes('p1', map.width).at(-1)!).row,
    );
    expect(axialToOffset(sweepLanes('p2', map.width)[0]).row).toBeLessThan(
      axialToOffset(sweepLanes('p2', map.width).at(-1)!).row,
    );
  });
});

describe('nextSweepWaypoint', () => {
  const lanes = sweepLanes('p1', 16);

  it('converges on the nearest lane while still out of range of it', () => {
    const spawn = offsetToAxial(SPAWNS.p1.drone);
    const nearest = lanes.reduce((best, lane) =>
      distance(spawn, lane) < distance(spawn, best) ? lane : best,
    );
    expect(distance(spawn, nearest)).toBeGreaterThan(UNIT_DEFS.drone.movement);
    expect(nextSweepWaypoint(spawn, lanes)).toEqual(nearest);
  });

  it('marches to the following lane once standing on one', () => {
    expect(nextSweepWaypoint(lanes[0], lanes)).toEqual(lanes[1]);
    expect(nextSweepWaypoint(lanes[2], lanes)).toEqual(lanes[3]);
  });

  it('wraps at the end of the tour, so the sweep repeats forever', () => {
    // Re-sweeping is the point: launchers relocate, so a zone photographed on
    // round 5 is stale by round 12.
    expect(nextSweepWaypoint(lanes.at(-1)!, lanes)).toEqual(lanes[0]);
  });
});

describe('the drone actually searches the enemy home zone', () => {
  const map = plainsMap();

  /** Fly the CPU's own drone for `rounds` rounds with nothing shooting at it,
   * and report what share of the enemy home zone it photographed. */
  function sweptFraction(difficulty: CpuDifficulty, player: PlayerId, rounds: number): number {
    let drone = makeUnit('D1', player, 'drone', offsetToAxial(SPAWNS[player].drone));
    const seen = new Set<string>();

    for (let round = 1; round <= rounds; round++) {
      const view = makeView(map, [drone], {}, { round });
      const fly = cpuOrders(view, difficulty, player, makeRng(round)).find(
        (o) => o.type === 'FLY',
      );
      if (!fly) continue;
      for (const key of reconSwath(hexLine(drone.position, fly.destination))) seen.add(key);
      drone = { ...drone, position: fly.destination };
    }

    const zone = RULES.homeZoneRows[opponentOf(player)];
    let total = 0;
    let covered = 0;
    for (let col = 0; col < map.width; col++) {
      for (let row = zone.min; row <= zone.max; row++) {
        total += 1;
        if (seen.has(hexKey(offsetToAxial({ col, row })))) covered += 1;
      }
    }
    return covered / total;
  }

  it('covers most of the enemy home zone within a match, for both players', () => {
    // THE REGRESSION GUARD for the defect this replaced: the old heuristic
    // minimised |row - advanceRow|, which parked the drone on the zone's near
    // edge from round 2 and re-photographed one corridor forever — measured at
    // 13% of the zone over a whole 22-round match. Anything that reintroduces a
    // stationary or purely row-seeking drone fails here.
    for (const player of PLAYERS) {
      for (const difficulty of ['medium', 'hard'] as const) {
        expect(sweptFraction(difficulty, player, 12)).toBeGreaterThan(0.75);
      }
    }
  });

  it('keeps moving instead of parking once it reaches the zone', () => {
    const player: PlayerId = 'p1';
    const zone = RULES.homeZoneRows[opponentOf(player)];
    const drone = makeUnit('D1', player, 'drone', offsetToAxial({ col: 8, row: zone.max }));
    const view = makeView(map, [drone]);

    for (const difficulty of ['medium', 'hard'] as const) {
      const fly = cpuOrders(view, difficulty, player, makeRng(1)).find((o) => o.type === 'FLY');
      expect(fly).toBeDefined();
      expect(hexKey(fly!.destination)).not.toBe(hexKey(drone.position));
    }
  });
});

// ---------------------------------------------------------------------------
// HARD prosecutes a known site; MEDIUM does not
// ---------------------------------------------------------------------------

describe('site-seeking movement', () => {
  const player: PlayerId = 'p1';
  const map = plainsMap();
  // Out at the western edge, so driving at it and pushing straight up the board
  // are visibly different moves rather than the same one by coincidence.
  const site = offsetToAxial({ col: 1, row: 2 });
  const start = offsetToAxial({ col: 14, row: 12 });

  function moveOf(difficulty: CpuDifficulty): Hex {
    const launcher = makeUnit('L1', player, 'launcher', start);
    const view = makeView(map, [launcher], { staticReveals: [staticReveal(site)] });
    const order = cpuOrders(view, difficulty, player, makeRng(1)).find((o) => o.type === 'MOVE');
    expect(order).toBeDefined();
    return (order as Extract<Order, { type: 'MOVE' }>).destination;
  }

  it('HARD closes on a known site that is out of missile range', () => {
    // Asserted against the best hex actually available, not merely "closer than
    // where it started" — a plain row advance also shortens the gap to a site
    // that happens to sit up the board, so the weaker form passes even with
    // site-seeking removed entirely.
    const launcher = makeUnit('L1', player, 'launcher', start);
    const believed = believedStateFor(map, [launcher]);
    const best = Math.min(
      ...[...reachableHexes(believed, launcher).values()]
        .map((r) => r.hex)
        .filter((hex) => hexKey(hex) !== hexKey(start))
        .map((hex) => Math.max(0, distance(hex, site) - RULES.missileRange)),
    );

    expect(Math.max(0, distance(moveOf('hard'), site) - RULES.missileRange)).toBe(best);
    expect(distance(moveOf('hard'), site)).toBeLessThan(distance(start, site));
  });

  it('MEDIUM ignores the site and pushes up the board instead', () => {
    // The tier distinction, asserted as a real behavioural difference rather
    // than trusted to a flag: MEDIUM fights the front, HARD hunts the bunker.
    expect(distance(moveOf('medium'), site)).toBeGreaterThan(distance(moveOf('hard'), site));
  });

  it('HARD fires rather than closing once the site is within missile range', () => {
    // `advanceScore` floors at 0 inside range, so approach stops at the edge of
    // reach — but a shot beats a move outright, so what we observe is the shot.
    const near = offsetToAxial({ col: 3, row: 7 });
    expect(distance(near, site)).toBeLessThanOrEqual(RULES.missileRange);

    const launcher = makeUnit('L1', player, 'launcher', near);
    const view = makeView(map, [launcher], { staticReveals: [staticReveal(site)] });
    const launch = cpuOrders(view, 'hard', player, makeRng(1)).find((o) => o.type === 'LAUNCH');

    expect(launch).toBeDefined();
    expect(hexKey((launch as Extract<Order, { type: 'LAUNCH' }>).target)).toBe(hexKey(site));
  });
});
