// RENDER LAYER — pixel geometry. Reads nothing, mutates nothing.
//
// The one place hex coordinates become pixels. Both `draw.ts` and `GameCanvas`
// go through it, for the same reason the sim has exactly one `hexLine`: two
// implementations of the same conversion drift, and here they would drift into
// units drawn slightly off their own tiles.

/** Hex radius in pixels (centre to corner). */
export const HEX = 26;

/**
 * Centre of the tile at odd-q offset coordinates `col`/`row`.
 *
 * Flat-top hexes have a flat edge on top and bottom, so columns stack directly
 * north/south of each other — the odd-q offset instead shifts alternating
 * *columns* vertically, and adjacent columns are the diagonal NE/SE/NW/SW
 * neighbours.
 *
 * That is exactly why the game is fought north/south (spec §7): a flat-top hex
 * has a true N and S neighbour and none directly E or W, so advancing up the
 * board is a straight line. P1 holds the southern (high-row) edge.
 *
 * Takes offset coordinates rather than axial because that is what `MapData`
 * stores; anything holding an axial `Hex` converts with `axialToOffset` first.
 */
export function hexCenter(col: number, row: number): { x: number; y: number } {
  const h = Math.sqrt(3) * HEX;
  return {
    x: HEX * 1.5 * col + HEX * 2,
    y: h * (row + 0.5 * (col % 2)) + h,
  };
}

/** The six corners of a flat-top hex, flattened to [x0, y0, x1, y1, ...]. */
export function hexCorners(cx: number, cy: number, radius = HEX): number[] {
  const points: number[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i); // flat-top: first corner due east
    points.push(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
  }
  return points;
}
