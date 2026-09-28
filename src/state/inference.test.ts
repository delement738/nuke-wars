import { describe, expect, it } from 'vitest';
import { RULES, UNIT_DEFS } from '../sim/defs';
import {
  axialToOffset,
  distance,
  hexKey,
  hexLine,
  hexesInRange,
  offsetToAxial,
  type Hex,
} from '../sim/hex';
import { generateMap, makeRng, tileAt, type MapData, type TileData } from '../sim/map';
import { reconSwath } from '../sim/recon';
import { resolve } from '../sim/resolve';
import { startMatch } from '../sim/setup';
import {
  PLAYERS,
  opponentOf,
  type GameState,
  type PlayerId,
  type Unit,
  type UnitKind,
  type VisibleEvent,
  type VisibleGameState,
  type VisiblePlayerIntel,
} from '../sim/types';
import { filterEventsForPlayer, filterForPlayer } from '../sim/visibility';
import { cpuOrders, droneDangerHexes } from './cpu';
import { cpuSetup } from './cpuSetup';
import {
  downedOnFirstStep,
  enemyBaseCandidates,
  intelOverlay,
  photographedHexes,
} from './inference';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  units: readonly Unit[] = [],
  intel: Partial<VisiblePlayerIntel> = {},
): VisibleGameState {
  return {
    round: 1,
    phase: 'ORDER_PHASE',
    map,
    units: [...units],
    intel: { staticReveals: [], contacts: [], ...intel },
    droneRespawnIn: 0,
    deadHandFor: null,
    missiles: [],
    outcome: null,
  };
}

const map = plainsMap();
const R = RULES.interceptorCoverageRadius;
const zone = RULES.homeZoneRows.p2;
// Deep in p2's home zone, so the whole disc about it is legal base ground.
const death = offsetToAxial({ col: 8, row: 3 });

const downed = (owner: PlayerId, hex: Hex = death): VisibleEvent => ({
  type: 'DRONE_DOWNED',
  unitId: `${owner}-drone`,
  owner,
  hex,
});

const flew = (owner: PlayerId, path: Hex[]): VisibleEvent => ({
  type: 'DRONE_MOVED',
  unitId: `${owner}-drone`,
  owner,
  from: path[0],
  to: path[path.length - 1],
  path,
});

const keys = (hexes: readonly Hex[]): Set<string> => new Set(hexes.map(hexKey));

// ---------------------------------------------------------------------------
// enemyBaseCandidates
// ---------------------------------------------------------------------------

describe('enemyBaseCandidates — where the enemy base could be', () => {
  it('is the R-disc about our drone’s death hex when nothing else is known', () => {
    const candidates = enemyBaseCandidates(makeView(map), [downed('p1')], 'p1');
    expect(keys(candidates)).toEqual(keys(hexesInRange(death, R)));
  });

  it('is empty with no clue at all', () => {
    expect(enemyBaseCandidates(makeView(map), [], 'p1')).toEqual([]);
  });

  it('ignores the ENEMY drone dying — DRONE_DOWNED is public, and that one met OUR base', () => {
    expect(enemyBaseCandidates(makeView(map), [downed('p2')], 'p1')).toEqual([]);
  });

  it('is not moved by MISSILE_INTERCEPTED alone — an intercept always comes with BASE_EXPOSED', () => {
    const intercepted: VisibleEvent = { type: 'MISSILE_INTERCEPTED', missileId: 'r1@0,0', hex: death };
    expect(enemyBaseCandidates(makeView(map), [intercepted], 'p1')).toEqual([]);
  });

  it('keeps candidates inside the enemy home zone (§12)', () => {
    const edge = offsetToAxial({ col: 8, row: zone.max });
    const candidates = enemyBaseCandidates(makeView(map), [downed('p1', edge)], 'p1');
    expect(candidates.length).toBeGreaterThan(0);
    for (const hex of candidates) {
      const { row } = axialToOffset(hex);
      expect(row).toBeGreaterThanOrEqual(zone.min);
      expect(row).toBeLessThanOrEqual(zone.max);
    }
  });

  it('rules out anywhere within R of a hex our drone transmitted from safely', () => {
    const path = hexLine(offsetToAxial({ col: 2, row: 0 }), offsetToAxial({ col: 14, row: 0 }));
    const candidates = enemyBaseCandidates(makeView(map), [flew('p1', path), downed('p1')], 'p1');
    expect(candidates.length).toBeGreaterThan(0);
    for (const hex of candidates) {
      for (const step of path) expect(distance(hex, step)).toBeGreaterThan(R);
    }
  });

  it('intersects two deaths — one base must explain both', () => {
    const north = offsetToAxial({ col: 8, row: 3 - R });
    const south = offsetToAxial({ col: 8, row: 3 + R });
    const candidates = enemyBaseCandidates(makeView(map), [downed('p1', north), downed('p1', south)], 'p1');
    expect(candidates.map(hexKey)).toEqual([hexKey(death)]);
  });

  it('is empty once the base is on the map — the exact mark replaces the guess', () => {
    const base = offsetToAxial({ col: 8, row: 2 });
    const view = makeView(map, [], { staticReveals: [{ hex: base, kind: 'interceptor', round: 2 }] });
    expect(enemyBaseCandidates(view, [downed('p1')], 'p1')).toEqual([]);
  });

  it('is empty once an ENEMY base is destroyed near the clue, but not when it was ours', () => {
    const killed = (unitId: string): VisibleEvent => ({
      type: 'UNIT_DESTROYED',
      unitId,
      kind: 'interceptor',
      hex: death,
    });
    expect(enemyBaseCandidates(makeView(map), [downed('p1'), killed('p2-interceptor')], 'p1')).toEqual([]);

    const ours = { ...makeUnit('p1-interceptor', 'p1', 'interceptor', death), destroyed: true };
    expect(
      enemyBaseCandidates(makeView(map, [ours]), [downed('p1'), killed(ours.id)], 'p1').length,
    ).toBeGreaterThan(0);
  });

  it('is exactly what the CPU flies around: its danger is the coverage of these candidates', () => {
    const history = [downed('p1')];
    const expected = new Set<string>();
    for (const base of enemyBaseCandidates(makeView(map), history, 'p1')) {
      for (const hex of hexesInRange(base, R)) expected.add(hexKey(hex));
    }
    expect(droneDangerHexes(makeView(map), history, 'p1')).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// photographedHexes
// ---------------------------------------------------------------------------

describe('photographedHexes — the ground our drone has photographed', () => {
  it('is the recon swath of every flight, from the sim’s own reconSwath', () => {
    const path = hexLine(offsetToAxial({ col: 4, row: 10 }), offsetToAxial({ col: 4, row: 4 }));
    expect(keys(photographedHexes(map, [flew('p1', path)], 'p1'))).toEqual(reconSwath(path));
  });

  it('accumulates across rounds, counting each hex once', () => {
    const a = hexLine(offsetToAxial({ col: 4, row: 10 }), offsetToAxial({ col: 4, row: 4 }));
    const b = hexLine(offsetToAxial({ col: 4, row: 4 }), offsetToAxial({ col: 10, row: 4 }));
    const photographed = photographedHexes(map, [flew('p1', a), flew('p1', b)], 'p1');
    expect(new Set(photographed.map(hexKey)).size).toBe(photographed.length);
    expect(keys(photographed)).toEqual(new Set([...reconSwath(a), ...reconSwath(b)]));
  });

  it('a hover still photographs its own corridor (gotcha 17)', () => {
    const at = offsetToAxial({ col: 8, row: 9 });
    expect(photographedHexes(map, [flew('p1', [at])], 'p1')).toHaveLength(1 + 6 * RULES.reconSwathRadius);
  });

  it('never includes ground off the board (gotcha 37)', () => {
    const corner = offsetToAxial({ col: 0, row: 0 });
    const photographed = photographedHexes(map, [flew('p1', [corner])], 'p1');
    expect(photographed.length).toBeLessThan(1 + 6 * RULES.reconSwathRadius);
    for (const hex of photographed) expect(tileAt(map, axialToOffset(hex))).toBeDefined();
  });

  it('reads only our own flights', () => {
    const path = hexLine(offsetToAxial({ col: 4, row: 10 }), offsetToAxial({ col: 4, row: 4 }));
    expect(photographedHexes(map, [flew('p2', path)], 'p1')).toEqual([]);
  });
});

describe('downedOnFirstStep — a one-hex flight is a hover unless the drone died', () => {
  const start = offsetToAxial({ col: 8, row: 9 });
  const takeoff = flew('p1', [start]) as Extract<VisibleEvent, { type: 'DRONE_MOVED' }>;

  it('is true when our drone transmitted one hex and was downed the same round', () => {
    expect(downedOnFirstStep(takeoff, [takeoff, downed('p1')])).toBe(true);
  });

  it('is false for a real hover, and for the enemy’s drone going down', () => {
    expect(downedOnFirstStep(takeoff, [takeoff])).toBe(false);
    expect(downedOnFirstStep(takeoff, [takeoff, downed('p2')])).toBe(false);
  });

  it('is false for a longer flight that was downed — that one reads as a flight', () => {
    const path = hexLine(start, offsetToAxial({ col: 8, row: 6 }));
    const longer = flew('p1', path) as Extract<VisibleEvent, { type: 'DRONE_MOVED' }>;
    expect(downedOnFirstStep(longer, [longer, downed('p1')])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// intelOverlay — what the board draws
// ---------------------------------------------------------------------------

describe('intelOverlay', () => {
  const path = hexLine(offsetToAxial({ col: 8, row: 9 }), offsetToAxial({ col: 8, row: 5 }));
  const log = [
    { round: 2, event: flew('p1', path) },
    { round: 3, event: downed('p1') },
  ];

  it('draws the whole log over the current board when no replay is pending', () => {
    const overlay = intelOverlay(makeView(map), log, null, 'p1');
    expect(overlay.candidates.length).toBeGreaterThan(0);
    expect(keys(overlay.photographed)).toEqual(reconSwath(path));
  });

  it('holds back the round being replayed, so the shading cannot spoil the replay', () => {
    const replay = { round: 3, from: makeView(map) };
    const overlay = intelOverlay(makeView(map), log, replay, 'p1');
    expect(overlay.candidates).toEqual([]);
    expect(keys(overlay.photographed)).toEqual(reconSwath(path));
  });

  it('reads the pre-round board during a replay, not the settled one', () => {
    // The base went public in the round being replayed: the settled board
    // knows it, the backdrop does not — and round 3 is withheld either way, so
    // the only clue left is the round-2 death.
    const base = offsetToAxial({ col: 8, row: 2 });
    const settled = makeView(map, [], { staticReveals: [{ hex: base, kind: 'interceptor', round: 3 }] });
    const earlier = [{ round: 2, event: downed('p1') }, { round: 3, event: flew('p1', path) }];

    expect(intelOverlay(settled, earlier, null, 'p1').candidates).toEqual([]);
    expect(
      intelOverlay(settled, earlier, { round: 3, from: makeView(map) }, 'p1').candidates.length,
    ).toBeGreaterThan(0);
  });

  it('keeps every candidate on the board, even when the inference falls back to the raw disc', () => {
    // Contradictory clues — a safe hover on the very corner the drone later
    // died beside — prune every candidate away, so `enemyBaseCandidates` falls
    // back to the whole disc, half of which is off the board (gotcha 37).
    const corner = offsetToAxial({ col: 0, row: 0 });
    const history = [
      { round: 1, event: flew('p1', [corner]) },
      { round: 2, event: downed('p1', corner) },
    ];
    const raw = enemyBaseCandidates(makeView(map), history.map((e) => e.event), 'p1');
    expect(raw.some((hex) => !tileAt(map, axialToOffset(hex)))).toBe(true);

    const overlay = intelOverlay(makeView(map), history, null, 'p1');
    expect(overlay.candidates.length).toBeGreaterThan(0);
    for (const hex of overlay.candidates) expect(tileAt(map, axialToOffset(hex))).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Soundness over real matches: the shading never lies
// ---------------------------------------------------------------------------

describe('intelOverlay over real HARD matches', () => {
  it('always contains the true enemy base, and photographed ground hides no unseen site', () => {
    let shadedRounds = 0;
    let photographedSites = 0;

    for (let seed = 1; seed <= 12; seed++) {
      const board = generateMap(undefined, undefined, seed);
      const setupRng = makeRng(seed);
      let state: GameState = startMatch(board, {
        p1: cpuSetup(board, 'p1', 'hard', setupRng),
        p2: cpuSetup(board, 'p2', 'hard', setupRng),
      });
      const logs: Record<PlayerId, { round: number; event: VisibleEvent }[]> = { p1: [], p2: [] };

      for (let round = 1; round <= RULES.roundCap && state.phase !== 'GAME_OVER'; round++) {
        const orders = { p1: [] as ReturnType<typeof cpuOrders>, p2: [] as ReturnType<typeof cpuOrders> };
        for (const player of PLAYERS) {
          orders[player] = cpuOrders(
            filterForPlayer(state, player),
            'hard',
            player,
            makeRng(seed * 100000 + round * 2 + (player === 'p1' ? 0 : 1)),
            logs[player].map((entry) => entry.event),
          );
        }
        const result = resolve(state, orders.p1, orders.p2, seed);
        for (const player of PLAYERS) {
          for (const event of filterEventsForPlayer(result.events, player)) {
            logs[player].push({ round: state.round, event });
          }
        }
        state = result.state;

        for (const player of PLAYERS) {
          const view = filterForPlayer(state, player);
          const overlay = intelOverlay(view, logs[player], null, player);
          const enemy = opponentOf(player);
          const base = state.units.find(
            (u) => u.owner === enemy && u.kind === 'interceptor' && !u.destroyed,
          );

          if (overlay.candidates.length > 0) {
            shadedRounds += 1;
            expect(base).toBeDefined();
            expect(keys(overlay.candidates).has(hexKey(base!.position))).toBe(true);
          }

          const shot = keys(overlay.photographed);
          const known = keys(view.intel.staticReveals.map((r) => r.hex));
          for (const u of state.units) {
            if (u.owner !== enemy || u.destroyed) continue;
            if (u.kind !== 'bunker' && u.kind !== 'decoy') continue;
            if (!shot.has(hexKey(u.position))) continue;
            photographedSites += 1;
            expect(known.has(hexKey(u.position))).toBe(true);
          }
          for (const hex of overlay.candidates) expect(shot.has(hexKey(hex))).toBe(false);
        }
      }
    }

    // Not vacuous: the matches really did shade a region and photograph sites.
    expect(shadedRounds).toBeGreaterThan(0);
    expect(photographedSites).toBeGreaterThan(0);
  });
});
