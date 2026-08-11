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

/** Generates the left half, then mirrors it — both players get identical terrain. */
export function generateMap(width = 19, height = 15, seed = 42): MapData {
  const rand = makeRng(seed);
  const half = Math.ceil(width / 2);

  // Left-half terrain: ~14% mountains, rest plains
  const leftCols: Terrain[][] = [];
  for (let col = 0; col < half; col++) {
    const colTiles: Terrain[] = [];
    for (let row = 0; row < height; row++) {
      colTiles.push(rand() < 0.14 ? 'mountain' : 'plains');
    }
    leftCols.push(colTiles);
  }

  // Place 6 urban hexes in the home zone (leftmost 4 columns)
  let placed = 0;
  while (placed < 6) {
    const col = Math.floor(rand() * 4);
    const row = Math.floor(rand() * height);
    if (leftCols[col][row] === 'plains') {
      leftCols[col][row] = 'urban';
      placed++;
    }
  }

  // Build full map: right side mirrors the left
  const tiles: TileData[] = [];
  for (let col = 0; col < width; col++) {
    const src = col < half ? col : width - 1 - col;
    for (let row = 0; row < height; row++) {
      tiles.push({ col, row, terrain: leftCols[src][row] });
    }
  }

  const map: MapData = { width, height, tiles };

  // Spec §12: the 8 fixed spawn hexes are guaranteed plains. Without this a
  // seed could drop a mountain on a launcher's starting hex, which is not a
  // "hard map" — it is an immobile launcher and an unplayable game.
  //
  // Applied after mirroring rather than to the left half, because the spawn
  // list names both players' hexes explicitly. Symmetry survives regardless:
  // every P1 spawn's mirror image is itself a listed P2 spawn. A spawn that
  // rolled urban is converted too, so a player can end up with 5 urban hexes
  // instead of 6 — harmless, since urban is visual flavour only in V1 (§2).
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