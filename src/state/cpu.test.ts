import { describe, expect, it } from 'vitest';
import { UNIT_DEFS } from '../sim/defs';
import { axialToOffset, hexKey, offsetToAxial, type Hex } from '../sim/hex';
import { generateMap, makeRng, type MapData, type TileData } from '../sim/map';
import { validateLaunch as validateLaunchOrder } from '../sim/missiles';
import { reachableHexes, validateMove } from '../sim/movement';
import { validateFly } from '../sim/recon';
import { startMatch } from '../sim/setup';
import {
  opponentOf,
  PLAYERS,
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
  pickAdvanceDestination,
  SAFETY_DETOUR_TOLERANCE,
  selectTarget,
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

function staticReveal(hex: Hex): VisibleStaticReveal {
  return { hex, kind: 'bunker', round: 1 };
}

/** A real, freshly-started match's redacted view for `player` — the broad
 * legality/determinism checks run against this rather than a hand fixture, so
 * they exercise the real setup/spawn geometry too. */
function realView(seed: number, player: PlayerId): { view: VisibleGameState; map: MapData } {
  const map = generateMap(undefined, undefined, seed);
  const setups = { p1: sandboxSetup(map, 'p1'), p2: sandboxSetup(map, 'p2') };
  const state = startMatch(map, setups);
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
          const setups = { p1: sandboxSetup(map, 'p1'), p2: sandboxSetup(map, 'p2') };
          const truth = startMatch(map, setups);
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
  const nearSite = { hex: { q: 2, r: 0 }, priority: 1 }; // farther-priority, closer hex
  const farContact = { hex: { q: 4, r: 0 }, priority: 0 }; // higher-priority, farther hex

  it('unranked (MEDIUM): picks the nearest candidate, kind-blind', () => {
    expect(selectTarget([nearSite, farContact], from, false)).toEqual(nearSite);
  });

  it('ranked (HARD): picks the higher-priority candidate even though it is farther', () => {
    expect(selectTarget([nearSite, farContact], from, true)).toEqual(farContact);
  });

  it('returns undefined with no candidates', () => {
    expect(selectTarget([], from, true)).toBeUndefined();
  });
});

describe('cpuOrders — target priority wired end to end', () => {
  const player: PlayerId = 'p1';
  const map = plainsMap();
  const launcherPos = offsetToAxial({ col: 8, row: 10 });
  const closeReveal = staticReveal(offsetToAxial({ col: 8, row: 8 })); // distance 2
  const farContact = contact(offsetToAxial({ col: 8, row: 6 })); // distance 4, still <= range 6

  function fixtureView(): VisibleGameState {
    const launcher = makeUnit('L1', player, 'launcher', launcherPos);
    return makeView(map, [launcher], {
      staticReveals: [closeReveal],
      contacts: [farContact],
    });
  }

  it('MEDIUM fires at the nearer known target regardless of kind', () => {
    const orders = cpuOrders(fixtureView(), 'medium', player, () => 0);
    expect(orders).toEqual<Order[]>([
      { type: 'LAUNCH', unitId: 'L1', target: closeReveal.hex },
    ]);
  });

  it('HARD fires at the farther launcher contact over the nearer site', () => {
    const orders = cpuOrders(fixtureView(), 'hard', player, () => 0);
    expect(orders).toEqual<Order[]>([
      { type: 'LAUNCH', unitId: 'L1', target: farContact.hex },
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

  function scoredReachable() {
    return [...reachableHexes(believed, launcher).values()]
      .map((r) => r.hex)
      .filter((hex) => hexKey(hex) !== hexKey(start))
      .map((hex) => ({ hex, score: Math.abs(axialToOffset(hex).row - targetRow) }))
      .sort((a, b) => a.score - b.score);
  }

  it('picks the most-advanced reachable hex when nothing is dangerous', () => {
    const scored = scoredReachable();
    const destination = pickAdvanceDestination(believed, launcher, targetRow, new Set(), null);
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
    const destination = pickAdvanceDestination(believed, launcher, targetRow, new Set(), danger);

    expect(destination).not.toBeNull();
    expect(hexKey(destination!)).not.toBe(hexKey(best.hex));
    expect(Math.abs(axialToOffset(destination!).row - targetRow)).toBeLessThanOrEqual(
      best.score + SAFETY_DETOUR_TOLERANCE,
    );
  });

  it('never returns a hex in `avoid`, even if it is the only progress available', () => {
    const scored = scoredReachable();
    const avoid = new Set(scored.map((c) => hexKey(c.hex)));
    expect(pickAdvanceDestination(believed, launcher, targetRow, avoid, null)).toBeNull();
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
