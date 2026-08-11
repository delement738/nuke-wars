import { describe, expect, it } from 'vitest';
import { ALL_SPAWN_HEXES, RULES, SPAWNS, TERRAIN_GEN } from './defs';
import {
  axialToOffset,
  distance,
  hexKey,
  hexesInRange,
  neighbors,
  offsetToAxial,
} from './hex';
import { generateMap, groundCostsFrom, rotate180, tileAt } from './map';

const WIDTH = 16;
const HEIGHT = 19;

/**
 * Seeds to sweep. Terrain is random-but-seeded, so a guarantee that only holds
 * for seed 42 is not a guarantee — these properties must hold for every map the
 * generator can produce.
 */
const SEEDS = [1, 2, 7, 42, 99, 1234, 8675309];

/** Every hex on a default-sized board. */
function allCells() {
  const cells = [];
  for (let col = 0; col < WIDTH; col++) {
    for (let row = 0; row < HEIGHT; row++) cells.push({ col, row });
  }
  return cells;
}

describe('generateMap — dimensions', () => {
  it('produces width * height tiles in column-major order', () => {
    const map = generateMap();
    expect(map.width).toBe(WIDTH);
    expect(map.height).toBe(HEIGHT);
    expect(map.tiles).toHaveLength(WIDTH * HEIGHT);
    expect(map.tiles[0]).toMatchObject({ col: 0, row: 0 });
    expect(map.tiles[HEIGHT]).toMatchObject({ col: 1, row: 0 });
  });

  it('is taller than it is wide — the fight runs north/south', () => {
    const map = generateMap();
    expect(map.height).toBeGreaterThan(map.width);
  });

  it('refuses an odd width, which would break the half-turn symmetry', () => {
    // The even-width requirement is load-bearing geometry, not a preference
    // (see rotate180's comment). Failing loudly beats generating a map that is
    // quietly unfair to one player.
    expect(() => generateMap(15, 19)).toThrow(/even/);
  });
});

describe('rotate180 — the map symmetry operation', () => {
  const dims = { width: WIDTH, height: HEIGHT };

  it('is its own inverse', () => {
    for (const cell of allCells()) {
      expect(rotate180(dims, rotate180(dims, cell))).toEqual(cell);
    }
  });

  it('keeps every rotated hex on the map', () => {
    for (const cell of allCells()) {
      const { col, row } = rotate180(dims, cell);
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(WIDTH);
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(HEIGHT);
    }
  });

  it('preserves the distance between every pair of hexes on the board', () => {
    // THE test that justifies the whole layout. Terrain that is "the same
    // shape" for both players is worthless if the two copies sit at different
    // hex distances from their owner's spawns — the map would be quietly
    // unfair in a way no playtest would ever pin down.
    //
    // A top/bottom MIRROR fails this outright on flat-top odd-q hexes: odd
    // columns sit half a hex lower, so reflecting rows shears the grid. The
    // half-turn is a true isometry instead, and only while the width is even.
    // If someone "tidies" the map to an odd width or swaps the rotation for a
    // mirror, this fails rather than silently handicapping a player.
    const cells = allCells();
    for (const a of cells) {
      for (const b of cells) {
        const direct = distance(offsetToAxial(a), offsetToAxial(b));
        const rotated = distance(
          offsetToAxial(rotate180(dims, a)),
          offsetToAxial(rotate180(dims, b)),
        );
        expect(rotated, `distortion between ${a.col},${a.row} and ${b.col},${b.row}`).toBe(direct);
      }
    }
  });
});

describe('generateMap — spawn hexes are always plains (spec §12)', () => {
  it.each(SEEDS)('every spawn hex is plains at seed %i', (seed) => {
    const map = generateMap(WIDTH, HEIGHT, seed);
    for (const spawn of ALL_SPAWN_HEXES) {
      const tile = tileAt(map, spawn);
      expect(tile, `spawn ${spawn.col},${spawn.row} is off-map`).toBeDefined();
      expect(tile?.terrain).toBe('plains');
    }
  });

  it('covers all 8 spawns — 3 launchers + 1 drone per player', () => {
    expect(ALL_SPAWN_HEXES).toHaveLength(8);
    expect(SPAWNS.p1.launchers).toHaveLength(3);
    expect(SPAWNS.p2.launchers).toHaveLength(3);
  });

  it('places both players symmetrically', () => {
    // Every P1 spawn's half-turn image must itself be a P2 spawn, which is what
    // lets generateMap force spawns to plains *after* the copy pass without
    // breaking the map's symmetry.
    const dims = { width: WIDTH, height: HEIGHT };
    const p2Keys = new Set(
      [...SPAWNS.p2.launchers, SPAWNS.p2.drone].map((s) => `${s.col},${s.row}`),
    );
    for (const spawn of [...SPAWNS.p1.launchers, SPAWNS.p1.drone]) {
      const opposite = rotate180(dims, spawn);
      expect(p2Keys).toContain(`${opposite.col},${opposite.row}`);
    }
  });

  it('starts P1 in the south and P2 in the north, inside their home zones', () => {
    // Guards against a transposed coordinate slipping through: a spawn written
    // (row, col) by mistake would still be on the map, just on the wrong side.
    for (const player of ['p1', 'p2'] as const) {
      const zone = RULES.homeZoneRows[player];
      for (const spawn of [...SPAWNS[player].launchers, SPAWNS[player].drone]) {
        expect(spawn.row).toBeGreaterThanOrEqual(zone.min);
        expect(spawn.row).toBeLessThanOrEqual(zone.max);
        expect(spawn.col).toBeLessThan(WIDTH);
      }
    }
    expect(RULES.homeZoneRows.p1.min).toBeGreaterThan(RULES.homeZoneRows.p2.max);
  });

  it('leaves 14 rows of ground between the opposing launcher lines', () => {
    // The §7 tuning premise: launcher speed 3 vs missile range 6 vs this gap
    // is what buys ~2 rounds of maneuver before the first exchange is possible.
    const p1Row = SPAWNS.p1.launchers[0].row;
    const p2Row = SPAWNS.p2.launchers[0].row;
    expect(p1Row - p2Row).toBe(14);
    expect(RULES.missileRange).toBeLessThan(p1Row - p2Row);
  });
});

describe('generateMap — symmetry', () => {
  it.each(SEEDS)('north and south halves match at seed %i', (seed) => {
    const map = generateMap(WIDTH, HEIGHT, seed);
    for (const cell of allCells()) {
      const here = tileAt(map, cell);
      const opposite = tileAt(map, rotate180(map, cell));
      expect(
        opposite?.terrain,
        `symmetry mismatch at ${cell.col},${cell.row}`,
      ).toBe(here?.terrain);
    }
  });

  it('is deterministic — the same seed produces an identical map', () => {
    // Still true despite generateMap's re-roll loop: the retry seeds derive
    // from the caller's seed, so the whole search is a pure function of it.
    expect(generateMap(WIDTH, HEIGHT, 42).tiles).toEqual(
      generateMap(WIDTH, HEIGHT, 42).tiles,
    );
  });
});

describe('generateMap — mountains (spec §2, §7)', () => {
  it.each(SEEDS)('covers a share of the board inside the tuned band at seed %i', (seed) => {
    const map = generateMap(WIDTH, HEIGHT, seed);
    const fraction =
      map.tiles.filter((t) => t.terrain === 'mountain').length /
      map.tiles.length;
    expect(fraction).toBeGreaterThanOrEqual(TERRAIN_GEN.mountainFractionBand.min);
    expect(fraction).toBeLessThanOrEqual(TERRAIN_GEN.mountainFractionBand.max);
  });

  it.each(SEEDS)('grows mountains in ranges, not as noise, at seed %i', (seed) => {
    // The property that separates "ridges" from "salt and pepper": a mountain
    // hex should almost always touch another one. Scattered singletons at the
    // same percentage would be speed bumps rather than terrain that shapes an
    // advance, and nothing else in the generator would notice the difference.
    const map = generateMap(WIDTH, HEIGHT, seed);
    const mountains = map.tiles.filter((t) => t.terrain === 'mountain');

    const lone = mountains.filter(
      (tile) =>
        !neighbors(offsetToAxial(tile)).some(
          (n) => tileAt(map, axialToOffset(n))?.terrain === 'mountain',
        ),
    );

    expect(
      lone.map((t) => `${t.col},${t.row}`),
      'every mountain must touch another — lone hexes are noise, not ranges',
    ).toEqual([]);
  });

  it.each(SEEDS)('keeps every spawn and its ring clear at seed %i', (seed) => {
    // Forcing the spawn hex itself to plains is not enough once mountains
    // cluster — a plains hex ringed by a ridge is a launcher that cannot move
    // for the whole match.
    const map = generateMap(WIDTH, HEIGHT, seed);
    for (const spawn of ALL_SPAWN_HEXES) {
      for (const hex of hexesInRange(
        offsetToAxial(spawn),
        TERRAIN_GEN.spawnClearanceRadius,
      )) {
        // Ring hexes may fall off the board edge; those simply don't exist.
        const tile = tileAt(map, axialToOffset(hex));
        if (tile) expect(tile.terrain).toBe('plains');
      }
    }
  });

  it.each(SEEDS)('leaves every spawn mutually reachable at seed %i', (seed) => {
    // A ridge across the board, or a launcher walled into a pocket, is the
    // failure mode clustering introduces and scattering never could.
    const map = generateMap(WIDTH, HEIGHT, seed);
    const reachable = groundCostsFrom(map, ALL_SPAWN_HEXES[0]);
    for (const spawn of ALL_SPAWN_HEXES) {
      expect(
        reachable.has(hexKey(offsetToAxial(spawn))),
        `spawn ${spawn.col},${spawn.row} is cut off from the rest of the board`,
      ).toBe(true);
    }
  });

  it.each(SEEDS)('keeps the §7 approach premise intact at seed %i', (seed) => {
    // §7 is tuned on a launcher closing to firing range in ~3 rounds. Detours
    // around ridges lengthen that, and enough of them turn matches into
    // Armistice draws — so the generator re-rolls rather than ship one.
    const map = generateMap(WIDTH, HEIGHT, seed);

    for (const player of ['p1', 'p2'] as const) {
      const enemy = player === 'p1' ? 'p2' : 'p1';

      const firingPositions = new Set<string>();
      for (const enemySpawn of SPAWNS[enemy].launchers) {
        for (const hex of hexesInRange(
          offsetToAxial(enemySpawn),
          RULES.missileRange,
        )) {
          firingPositions.add(hexKey(hex));
        }
      }

      for (const spawn of SPAWNS[player].launchers) {
        const costs = groundCostsFrom(map, spawn);
        let closest = Infinity;
        for (const [key, cost] of costs) {
          if (firingPositions.has(key) && cost < closest) closest = cost;
        }
        expect(
          closest,
          `${player} launcher at ${spawn.col},${spawn.row} needs ${closest} to reach firing range`,
        ).toBeLessThanOrEqual(TERRAIN_GEN.maxApproachCost);
      }
    }
  });

  it('refuses dimensions the spawn table does not fit on', () => {
    // Without this the spawns fall off the edge, every attempt fails the
    // connectivity check, and generateMap reports "no playable map" — a
    // thoroughly misleading way to say "there is no spawn table for that size".
    expect(() => generateMap(8, 9)).toThrow(/SPAWNS/);
  });
});
