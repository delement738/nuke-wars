// RENDER LAYER — pixel geometry. Reads no game state and mutates none; its one
// setting is which way up the board is drawn (`setBoardTurned`).
//
// The one place hex coordinates become pixels. Both `draw.ts` and `GameCanvas`
// go through it, for the same reason the sim has exactly one `hexLine`: two
// implementations of the same conversion drift, and here they would drift into
// units drawn slightly off their own tiles.

import { rotate180 } from '../sim/map';

/** Hex radius in pixels (centre to corner). */
export const HEX = 26;

/**
 * The board's dimensions while it is drawn turned a half-turn, or null while it
 * is drawn the right way up.
 *
 * Every player sees their own home at the bottom of the screen: P1's already
 * is (the south edge), and P2's view is turned 180° so the north edge comes
 * round to the bottom. A half-turn and not a mirror for the reason `rotate180`
 * gives — on this grid a top/bottom mirror lands odd columns half a hex off —
 * and because the map is generated half-turn symmetric, P2 sees exactly the
 * board P1 sees.
 *
 * Presentation only: the sim, the store and the server all keep the true
 * coordinates, and the tiles are their own click targets, so a click on a
 * turned tile still reports that tile's real hex.
 *
 * Module state rather than a parameter because every position on the board,
 * in both draw files, comes through `hexCenter`; `GameCanvas` sets it before
 * any layer draws and redraws every layer when it changes.
 */
let turned: { width: number; height: number } | null = null;

/** Draw the board turned a half-turn (pass the map's dimensions) or not (null). */
export function setBoardTurned(dims: { width: number; height: number } | null): void {
  turned = dims ? { width: dims.width, height: dims.height } : null;
}

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
 *
 * While the board is turned (`setBoardTurned`) the tile is drawn where its
 * half-turn image would stand.
 */
export function hexCenter(col: number, row: number): { x: number; y: number } {
  if (turned) ({ col, row } = rotate180(turned, { col, row }));
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
