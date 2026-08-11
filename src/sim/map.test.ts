import { describe, expect, it } from 'vitest';
import { ALL_SPAWN_HEXES, SPAWNS } from './defs';
import { generateMap, tileAt } from './map';

/**
 * Seeds to sweep. Terrain is random-but-seeded, so a guarantee that only holds
 * for seed 42 is not a guarantee — these properties must hold for every map the
 * generator can produce.
 */
const SEEDS = [1, 2, 7, 42, 99, 1234, 8675309];

describe('generateMap — dimensions', () => {
  it('produces width * height tiles in column-major order', () => {
    const map = generateMap();
    expect(map.width).toBe(19);
    expect(map.height).toBe(15);
    expect(map.tiles).toHaveLength(19 * 15);
    expect(map.tiles[0]).toMatchObject({ col: 0, row: 0 });
    expect(map.tiles[15]).toMatchObject({ col: 1, row: 0 });
  });
});

describe('generateMap — spawn hexes are always plains (spec §12)', () => {
  it.each(SEEDS)('every spawn hex is plains at seed %i', (seed) => {
    const map = generateMap(19, 15, seed);
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
    // Every P1 spawn's mirror image must itself be a P2 spawn, which is what
    // lets generateMap force spawns to plains *after* mirroring without
    // breaking the map's symmetry.
    const width = 19;
    const p2Keys = new Set(
      [...SPAWNS.p2.launchers, SPAWNS.p2.drone].map((s) => `${s.col},${s.row}`),
    );
    for (const spawn of [...SPAWNS.p1.launchers, SPAWNS.p1.drone]) {
      expect(p2Keys).toContain(`${width - 1 - spawn.col},${spawn.row}`);
    }
  });
});

describe('generateMap — mirroring', () => {
  it.each(SEEDS)('left and right halves match at seed %i', (seed) => {
    const map = generateMap(19, 15, seed);
    for (let col = 0; col < map.width; col++) {
      for (let row = 0; row < map.height; row++) {
        const left = tileAt(map, { col, row });
        const right = tileAt(map, { col: map.width - 1 - col, row });
        expect(
          right?.terrain,
          `mirror mismatch at ${col},${row}`,
        ).toBe(left?.terrain);
      }
    }
  });

  it('is deterministic — the same seed produces an identical map', () => {
    expect(generateMap(19, 15, 42).tiles).toEqual(generateMap(19, 15, 42).tiles);
  });
});
