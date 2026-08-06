// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.

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

  return { width, height, tiles };
}