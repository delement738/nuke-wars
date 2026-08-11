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

/**
 * A hex position with the third cube coordinate written out, allowing
 * fractional values. Real hexes are always whole numbers and always satisfy
 * q + r + s = 0; this type exists only for the in-between points produced while
 * interpolating along a line, before they are rounded back onto the grid.
 */
interface FractionalCube {
  q: number;
  r: number;
  s: number;
}

/**
 * The fixed epsilon nudge from spec §10, applied to BOTH endpoints of a line.
 *
 * Some lines pass exactly through the corner shared by two hexes, so the
 * interpolated point lands on a perfect .5 and rounding becomes a coin flip
 * decided by floating-point trivia. Offsetting every line by a millionth of a
 * hex means no point ever lands exactly on a boundary, so the choice is fixed
 * and identical everywhere.
 *
 * These constants are part of the spec, not an implementation detail: the sim,
 * the UI preview and the V1.5 server must all produce byte-identical paths, or
 * a player is shown a flight path the sim did not fly. Do not tune them, and do
 * not re-derive a line anywhere else — call `hexLine` instead.
 *
 * `s` is -3e-6 because cube coordinates must sum to zero; it is forced by the
 * other two, not independently chosen.
 */
const LINE_NUDGE: FractionalCube = { q: 1e-6, r: 2e-6, s: -3e-6 };

/**
 * Round a fractional cube position to the nearest real hex.
 *
 * Rounding the three coordinates independently can break the q + r + s = 0
 * invariant, so whichever coordinate moved furthest from its true value is
 * discarded and recomputed from the other two — the least-trustworthy component
 * is the one we throw away.
 */
function cubeRound(frac: FractionalCube): Hex {
  let q = Math.round(frac.q);
  let r = Math.round(frac.r);
  const s = Math.round(frac.s);

  const dq = Math.abs(q - frac.q);
  const dr = Math.abs(r - frac.r);
  const ds = Math.abs(s - frac.s);

  if (dq > dr && dq > ds) {
    q = -r - s;
  } else if (dr > ds) {
    r = -q - s;
  }
  // The remaining case recomputes s, which axial coordinates drop anyway.

  // Math.round(-0.4) is negative zero, and -0 is not deep-equal to 0. Left in,
  // it would make two structurally identical hexes compare as different and
  // break the determinism checks that compare whole resolved states (spec §6).
  return { q: noNegativeZero(q), r: noNegativeZero(r) };
}

/** Collapses -0 to 0; every other value passes through untouched. */
function noNegativeZero(n: number): number {
  return n === 0 ? 0 : n;
}

/**
 * The straight hex line from `a` to `b` (spec §10) — cube-coordinate lerp plus
 * rounding, per redblobgames.com/grids/hexagons/#line-drawing.
 *
 * Returns both endpoints: `a` first, `b` last, length `distance(a, b) + 1`.
 * Consecutive entries are always adjacent, and the line is reversible —
 * `hexLine(a, b)` reversed equals `hexLine(b, a)`.
 *
 * This is pure geometry and knows nothing about game rules: no range limit, no
 * terrain, no legality. Missiles ignore terrain by design (§10 — a mountain
 * bunker must stay killable), and range/legality checks belong to the order
 * validators. `hexLine(a, a)` returns `[a]` rather than throwing; "the drone may
 * not fly to its own hex" (§11) is a validation rule, not a geometric one.
 *
 * One primitive serves both callers: a missile checks every hex *after* the
 * origin for interception (`slice(1)`), while the drone's reveal swath covers
 * the whole array including its start hex (§10, §11).
 */
export function hexLine(a: Hex, b: Hex): Hex[] {
  const steps = distance(a, b);

  const from: FractionalCube = {
    q: a.q + LINE_NUDGE.q,
    r: a.r + LINE_NUDGE.r,
    s: -a.q - a.r + LINE_NUDGE.s,
  };
  const to: FractionalCube = {
    q: b.q + LINE_NUDGE.q,
    r: b.r + LINE_NUDGE.r,
    s: -b.q - b.r + LINE_NUDGE.s,
  };

  // max(steps, 1) guards a === b, where the loop runs once and t is always 0.
  const stepSize = 1 / Math.max(steps, 1);

  const line: Hex[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = stepSize * i;
    line.push(
      cubeRound({
        q: from.q + (to.q - from.q) * t,
        r: from.r + (to.r - from.r) * t,
        s: from.s + (to.s - from.s) * t,
      }),
    );
  }
  return line;
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
