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
