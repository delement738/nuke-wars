// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.

import { ALL_SPAWN_HEXES } from './defs';
import type { Offset } from './hex';

export type Terrain = 'plains' | 'mountain' | 'urban';

export interface TileData {
  col: number;
  row: number;
  terrain: Terrain;
}

export interface MapData {
  width: number;
  height: number;
  tiles: TileData[];
}

/** Seeded RNG (mulberry32) — same seed always produces the same map. */
export function makeRng(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The same hex seen from the other player's end of the board — a 180° rotation
 * about the map's centre. This is the map's symmetry operation (spec §7): P1
 * holds the south, P2 the north, and every hex of P1's ground corresponds to
 * exactly one hex of P2's.
 *
 * Why a rotation and not a top/bottom mirror, which is the obvious thing to
 * reach for: the map is flat-top hexes in odd-q offset coordinates, so odd
 * columns sit half a hex lower than even ones. That stagger makes a horizontal
 * mirror geometrically impossible — reflecting `row` lands odd columns half a
 * hex off the grid, so mirrored terrain would sit at subtly different distances
 * for the two players. A half-turn has no such problem *provided the width is
 * even* (see the guard in `generateMap`), and it is a true isometry: distances,
 * adjacency, and movement costs all survive it exactly. `map.test.ts` asserts
 * that over every pair of hexes on the board, so this is checked, not assumed.
 */
export function rotate180(
  dims: { width: number; height: number },
  offset: Offset,
): Offset {
  return {
    col: dims.width - 1 - offset.col,
    row: dims.height - 1 - offset.row,
  };
}

/**
 * Generates the northern half, then rotates it onto the southern half — both
 * players get terrain identical from their own end of the board.
 *
 * The generated half is P2's (north). P1's ground is its half-turn image, so a
 * mountain 3 rows ahead of a P2 launcher is 3 rows ahead of the corresponding
 * P1 launcher too.
 */
export function generateMap(width = 16, height = 19, seed = 42): MapData {
  if (width % 2 !== 0) {
    // Not a style preference — with an odd width the centre column maps onto
    // itself under the half-turn while its own stagger does not, and the two
    // halves stop being congruent. See `rotate180` above.
    throw new Error(
      `map width must be even for the half-turn symmetry to hold, got ${width}`,
    );
  }

  const rand = makeRng(seed);

  /**
   * Whether this hex is in the half we actually roll terrain for. The other
   * half is copied from its rotation, so exactly one hex of each rotated pair
   * is a source. With an odd height the centre row pairs with itself — the
   * col tiebreak splits it down the middle, and the even-width guard above
   * guarantees no hex is ever its own pair.
   */
  const isSource = ({ col, row }: Offset): boolean => {
    const opposite = rotate180({ width, height }, { col, row });
    return row < opposite.row || (row === opposite.row && col < opposite.col);
  };

  // terrain[col][row]. Pre-filled so every cell is a real Terrain at all times:
  // source cells are overwritten by the roll below, the rest by the copy pass.
  const terrain: Terrain[][] = Array.from({ length: width }, () =>
    new Array<Terrain>(height).fill('plains'),
  );

  // Northern-half terrain: ~14% mountains, rest plains
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < height; row++) {
      if (!isSource({ col, row })) continue;
      terrain[col][row] = rand() < 0.14 ? 'mountain' : 'plains';
    }
  }

  // Place 6 urban hexes in the northern home zone (its outermost 4 rows).
  // These land in P1's home zone once rotated, so each player gets 6.
  let placed = 0;
  while (placed < 6) {
    const col = Math.floor(rand() * width);
    const row = Math.floor(rand() * 4);
    if (terrain[col][row] === 'plains') {
      terrain[col][row] = 'urban';
      placed++;
    }
  }

  // Copy the generated half onto the other one.
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < height; row++) {
      if (isSource({ col, row })) continue;
      const src = rotate180({ width, height }, { col, row });
      terrain[col][row] = terrain[src.col][src.row];
    }
  }

  // Column-major, which is what tileAt's O(1) index math depends on.
  const tiles: TileData[] = [];
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < height; row++) {
      tiles.push({ col, row, terrain: terrain[col][row] });
    }
  }

  const map: MapData = { width, height, tiles };

  // Spec §12: the 8 fixed spawn hexes are guaranteed plains. Without this a
  // seed could drop a mountain on a launcher's starting hex, which is not a
  // "hard map" — it is an immobile launcher and an unplayable game.
  //
  // Applied after the copy pass rather than to the generated half, because the
  // spawn list names both players' hexes explicitly. Symmetry survives
  // regardless: every P1 spawn's half-turn image is itself a listed P2 spawn.
  //
  // A spawn that rolled urban is converted too. All 4 of a player's spawns sit
  // inside the 4-row urban band, so a player can end up with as few as 2 urban
  // hexes instead of 6 — harmless, since urban is visual flavour only in V1
  // (§2), and it is always the same number for both players. If urban ever
  // gains a game effect, place it outside the spawn hexes instead.
  for (const spawn of ALL_SPAWN_HEXES) {
    const tile = tileAt(map, spawn);
    if (tile) tile.terrain = 'plains';
  }

  return map;
}

/**
 * The tile at a col/row, or `undefined` if the position is off the map.
 *
 * O(1): `generateMap` fills `tiles` in column-major order (every row of col 0,
 * then every row of col 1...), so a tile's index is `col * height + row`.
 * That shortcut depends on the fill order above, so `tileAt` is unit-tested
 * against a linear search across the whole map — if the two ever disagree,
 * the test fails rather than movement silently reading the wrong terrain.
 *
 * Note this is the *only* correct way to bounds-check a position: the map is a
 * rectangle in col/row, which is a slanted parallelogram in axial space, so
 * there's no clean "is this hex on the map" test in axial coordinates.
 */
export function tileAt(map: MapData, offset: Offset): TileData | undefined {
  const { col, row } = offset;
  if (col < 0 || col >= map.width || row < 0 || row >= map.height) {
    return undefined;
  }
  return map.tiles[col * map.height + row];
}
