// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// Axial hex-grid math, per the conventions at redblobgames.com/grids/hexagons/.
// Coordinates are (q, r); the implicit third cube coordinate is s = -q - r.
// Orientation-agnostic — works for both pointy-top and flat-top layouts, since
// only the pixel-projection step (owned by the renderer) depends on that choice.

export interface Hex {
  q: number;
  r: number;
}

/** The six axial direction vectors, in clockwise order starting east. */
const DIRECTIONS: readonly Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

/** Hex distance between two tiles (number of steps a piece must take to move between them). */
export function distance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** The six hexes adjacent to `hex`, in clockwise order starting east. */
export function neighbors(hex: Hex): Hex[] {
  return DIRECTIONS.map((dir) => ({ q: hex.q + dir.q, r: hex.r + dir.r }));
}

/** All hexes within `range` steps of `center` (inclusive), including `center` itself. */
export function hexesInRange(center: Hex, range: number): Hex[] {
  const results: Hex[] = [];
  for (let dq = -range; dq <= range; dq++) {
    const rMin = Math.max(-range, -dq - range);
    const rMax = Math.min(range, -dq + range);
    for (let dr = rMin; dr <= rMax; dr++) {
      results.push({ q: center.q + dq, r: center.r + dr });
    }
  }
  return results;
}

/** Stable string key for putting hexes in Sets and Maps — "q,r". */
export function hexKey(hex: Hex): string {
  return `${hex.q},${hex.r}`;
}

/**
 * A position in the map's rectangular grid, in "odd-q" offset coordinates for
 * flat-top hexes: odd-numbered columns sit half a hex lower than even ones.
 *
 * This is the coordinate system `MapData`/`TileData` store and the renderer
 * draws (`hexCenter` in GameCanvas.tsx offsets odd columns by `0.5 * (col % 2)`).
 * The sim reasons in axial `Hex`; offsets exist only at that boundary.
 */
export interface Offset {
  col: number;
  row: number;
}

/**
 * Offset (odd-q) -> axial. Every 2 columns east, the axial row origin shifts
 * one step north, which is what keeps the two systems describing the same grid.
 */
export function offsetToAxial(offset: Offset): Hex {
  return {
    q: offset.col,
    r: offset.row - (offset.col - (offset.col & 1)) / 2,
  };
}

/** Axial -> offset (odd-q). Exact inverse of `offsetToAxial`. */
export function axialToOffset(hex: Hex): Offset {
  return {
    col: hex.q,
    row: hex.r + (hex.q - (hex.q & 1)) / 2,
  };
}
