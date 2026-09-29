// UI LAYER — the title screen's moving map (V1.5 Session 2, identity).
//
// One seamless tile of "plotting table": a paper war map with a grid, contour
// lines, the game's own unit emblems in red, and flight arcs between them. The
// title screen repeats it and slides it left at `DRIFT_PX_PER_S`, so the board
// behind the title is always on the move. Style from the designer's reference
// art, `public/art/title-inspo.png`; see `docs/art-direction.md`.
//
// **Why a generated tile rather than the reference picture:** the picture has
// the title lettered into it (the screen sets the title as live text on top), a
// phone's Edit/Share buttons captured in one corner, and edges that do not
// meet, so it cannot loop. The tile is drawn from `EMBLEM`, the same shapes as
// the board and the legend (gotcha 72), so the title screen shows the real
// pieces.
//
// **How it loops:** each layer is drawn once inside its own `<g>`, then stamped
// again at every neighbouring tile offset with `<use>`. Anything hanging off one
// edge therefore comes back in through the opposite one, and the tile repeats
// with no seam, whatever crosses its border.
//
// Pure string-building: no DOM, no React, and no `Math.random()` — the layout
// comes from a fixed seed so the tile is the same on every load (and testable).
//
// It shows no match, no player and nothing from the store: just decoration.

import type { UnitKind } from '../sim/types';
import { emblemPaths } from '../render/emblems';

/** Tile size in CSS pixels. Both are whole multiples of `GRID`, so the grid lines meet across the seam. */
export const TILE_W = 1440;
export const TILE_H = 960;
export const GRID = 120;

/** The designer's pace: the map slides left 20 px a second. */
export const DRIFT_PX_PER_S = 20;

/** How long one full tile takes to pass, which is the CSS animation's period. */
export const DRIFT_PERIOD_S = TILE_W / DRIFT_PX_PER_S;

/** The palette of the reference art. `docs/art-direction.md` names these. */
export const MAP_INK = {
  paper: '#e9e4d0',
  land: '#d3d9bb',
  grid: '#cbc4a8',
  contour: '#b8b396',
  label: '#9a937a',
  red: '#b3362a',
  ink: '#29251f',
  smoke: '#a6998a',
} as const;

// ---------------------------------------------------------------------------
// The composition. Hand-placed so the tile reads as two forces facing each
// other across the table, with a target ringed in the middle of each half.
// (x, y) is the emblem's centre in tile pixels; `flip` mirrors it so a
// launcher can face left.

interface Piece {
  kind: UnitKind;
  x: number;
  y: number;
  flip?: boolean;
}

const PIECES: readonly Piece[] = [
  // West force.
  { kind: 'bunker', x: 110, y: 170 },
  { kind: 'launcher', x: 90, y: 400 },
  { kind: 'interceptor', x: 250, y: 300 },
  { kind: 'launcher', x: 200, y: 600 },
  { kind: 'bunker', x: 360, y: 180 },
  { kind: 'drone', x: 330, y: 470 },
  { kind: 'interceptor', x: 470, y: 380 },
  { kind: 'launcher', x: 120, y: 820 },
  { kind: 'bunker', x: 420, y: 700 },
  { kind: 'interceptor', x: 330, y: 880 },
  // The first target, ringed.
  { kind: 'bunker', x: 660, y: 560 },
  // East force.
  { kind: 'launcher', x: 900, y: 250, flip: true },
  { kind: 'interceptor', x: 1010, y: 130 },
  { kind: 'bunker', x: 1210, y: 150 },
  { kind: 'drone', x: 880, y: 760 },
  { kind: 'launcher', x: 1330, y: 360, flip: true },
  { kind: 'interceptor', x: 1180, y: 520 },
  { kind: 'launcher', x: 1060, y: 880, flip: true },
  { kind: 'bunker', x: 1340, y: 740 },
  // The second target, ringed.
  { kind: 'bunker', x: 1100, y: 400 },
];

/** Indexes into `PIECES` of the two ringed targets. */
const TARGETS = [10, 19] as const;

/** Flight arcs: from piece, to piece, how high the arc bows, and its line style. */
const ARCS: readonly { from: number; to: number; bow: number; dashed?: boolean }[] = [
  { from: 1, to: 10, bow: -160 },
  { from: 3, to: 10, bow: -90, dashed: true },
  { from: 6, to: 19, bow: -170 },
  { from: 7, to: 8, bow: -70 },
  { from: 11, to: 10, bow: -120, dashed: true },
  { from: 15, to: 19, bow: -60 },
  { from: 17, to: 10, bow: -150 },
  { from: 1, to: 2, bow: -40, dashed: true },
  // Crossing the right-hand seam on purpose: the wrap copies bring it back in.
  { from: 15, to: 0, bow: -200, dashed: true },
];

/** Mushroom clouds: centre-bottom x, y and a scale. */
const CLOUDS: readonly { x: number; y: number; s: number }[] = [
  { x: 560, y: 250, s: 1.6 },
  { x: 1280, y: 610, s: 1.1 },
];

/** Emblems are 24 units across; this makes them ~53 px on the table. */
const EMBLEM_SCALE = 2.2;

// ---------------------------------------------------------------------------

/** A small seeded generator (mulberry32) for the contour shapes. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A closed smooth path through the points (Catmull-Rom turned into Béziers). */
function smoothLoop(points: readonly [number, number][]): string {
  const n = points.length;
  const at = (i: number) => points[(i + n) % n];
  let d = `M${r1(at(0)[0])} ${r1(at(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = at(i - 1);
    const [x1, y1] = at(i);
    const [x2, y2] = at(i + 1);
    const [x3, y3] = at(i + 2);
    d +=
      `C${r1(x1 + (x2 - x0) / 6)} ${r1(y1 + (y2 - y0) / 6)} ` +
      `${r1(x2 - (x3 - x1) / 6)} ${r1(y2 - (y3 - y1) / 6)} ${r1(x2)} ${r1(y2)}`;
  }
  return `${d}Z`;
}

/** A lumpy closed ring around (cx, cy), the shape of a hill's contour. */
function blob(cx: number, cy: number, radius: number, wobble: readonly number[]): string {
  const steps = 18;
  const points: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const r =
      radius *
      (1 + wobble[0] * Math.sin(2 * a + wobble[1]) + wobble[2] * Math.sin(3 * a + wobble[3]));
    points.push([cx + Math.cos(a) * r * 1.35, cy + Math.sin(a) * r]);
  }
  return smoothLoop(points);
}

function terrain(): string {
  const next = rng(1983);
  let land = '';
  let lines = '';
  const hills = [
    [230, 520, 150],
    [800, 140, 120],
    [1150, 700, 170],
    [520, 880, 110],
    [1360, 60, 100],
  ] as const;
  for (const [cx, cy, radius] of hills) {
    const wobble = [0.08 + next() * 0.1, next() * 6, 0.05 + next() * 0.08, next() * 6];
    land += `<path d="${blob(cx, cy, radius, wobble)}"/>`;
    for (let ring = 0; ring < 4; ring++) {
      lines += `<path d="${blob(cx, cy, radius - ring * 24, wobble)}"/>`;
    }
  }
  return (
    `<g fill="${MAP_INK.land}" opacity="0.8">${land}</g>` +
    `<g fill="none" stroke="${MAP_INK.contour}" stroke-width="1.3">${lines}</g>`
  );
}

function grid(): string {
  let lines = '';
  for (let x = 0; x < TILE_W; x += GRID) lines += `<path d="M${x} 0V${TILE_H}"/>`;
  for (let y = 0; y < TILE_H; y += GRID) lines += `<path d="M0 ${y}H${TILE_W}"/>`;
  // Grid references like the reference art's margin notes: a column letter and
  // a row number in the corner of each square.
  let labels = '';
  const cols = 'ABCDEFGHJKLM';
  for (let x = 0; x < TILE_W; x += GRID) {
    for (let y = 0; y < TILE_H; y += GRID * 2) {
      labels += `<text x="${x + 6}" y="${y + 16}">${cols[x / GRID]}${y / GRID + 1}</text>`;
    }
  }
  return (
    `<g stroke="${MAP_INK.grid}" stroke-width="1.5">${lines}</g>` +
    `<g fill="${MAP_INK.label}" font-family="ui-monospace, Menlo, monospace" font-size="12">${labels}</g>`
  );
}

function arcs(): string {
  let solid = '';
  let dashed = '';
  let heads = '';
  for (const arc of ARCS) {
    const a = PIECES[arc.from];
    const b = PIECES[arc.to];
    // The arc wraps forward across the seam when its target lies far behind.
    const bx = b.x < a.x - TILE_W / 2 ? b.x + TILE_W : b.x;
    const cx = (a.x + bx) / 2;
    const cy = (a.y + b.y) / 2 + arc.bow;
    // Stop short of the target emblem so the arrowhead sits beside it, not on it.
    const len = Math.hypot(bx - cx, b.y - cy);
    const ex = bx - ((bx - cx) / len) * 40;
    const ey = b.y - ((b.y - cy) / len) * 40;
    const path = `<path d="M${a.x} ${a.y - 20}Q${r1(cx)} ${r1(cy)} ${r1(ex)} ${r1(ey)}"/>`;
    if (arc.dashed) dashed += path;
    else solid += path;
    // Arrowhead along the curve's last tangent (end point minus control point).
    const angle = (Math.atan2(ey - cy, ex - cx) * 180) / Math.PI;
    const colour = arc.dashed ? MAP_INK.ink : MAP_INK.red;
    heads += `<path fill="${colour}" transform="translate(${r1(ex)} ${r1(ey)}) rotate(${r1(angle)})" d="M4 0L-10 -6L-10 6Z"/>`;
  }
  return (
    `<g fill="none" stroke="${MAP_INK.red}" stroke-width="3" stroke-linecap="round">${solid}</g>` +
    `<g fill="none" stroke="${MAP_INK.ink}" stroke-width="2.5" stroke-dasharray="10 8">${dashed}</g>` +
    heads
  );
}

function reticle(x: number, y: number): string {
  const r = 72;
  const tick = (x1: number, y1: number, x2: number, y2: number) =>
    `<path d="M${x + x1} ${y + y1}L${x + x2} ${y + y2}"/>`;
  return (
    `<g fill="none" stroke="${MAP_INK.red}" stroke-width="7">` +
    `<circle cx="${x}" cy="${y}" r="${r}"/>` +
    tick(0, -r - 20, 0, -r + 18) +
    tick(0, r - 18, 0, r + 20) +
    tick(-r - 20, 0, -r + 18, 0) +
    tick(r - 18, 0, r + 20, 0) +
    `</g>`
  );
}

function cloud(x: number, y: number, s: number): string {
  // Drawn in a box about 40 wide, standing on (0, 0).
  return (
    `<g transform="translate(${x} ${y}) scale(${s})" fill="${MAP_INK.smoke}">` +
    `<path d="M-19 -30C-25 -40 -14 -50 -5 -46C-1 -55 15 -53 17 -43C26 -41 26 -30 17 -27C10 -23 -11 -23 -19 -30Z"/>` +
    `<path d="M-4 -25L4 -25L6 -3L-6 -3Z"/>` +
    `<path d="M-14 -13C-8 -17 8 -17 14 -13C8 -10 -8 -10 -14 -13Z"/>` +
    `<path d="M-20 0C-12 -7 12 -7 20 0Z"/>` +
    `</g>`
  );
}

function pieces(): string {
  let out = '';
  for (const piece of PIECES) {
    const sx = piece.flip ? -EMBLEM_SCALE : EMBLEM_SCALE;
    const shapes = emblemPaths(piece.kind)
      .map((d) => `<path fill-rule="evenodd" d="${d}"/>`)
      .join('');
    out += `<g transform="translate(${piece.x} ${piece.y}) scale(${sx} ${EMBLEM_SCALE})">${shapes}</g>`;
  }
  return `<g fill="${MAP_INK.red}" stroke="${MAP_INK.ink}" stroke-width="0.7" stroke-linejoin="round">${out}</g>`;
}

/** The whole tile as an SVG document. */
export function titleTileSvg(): string {
  // Bottom to top. Each layer is wrapped on its own (see header): wrapping the
  // whole picture at once would lay a neighbour's green land over this tile's
  // grid and labels near the seam.
  const layers = [
    terrain(),
    grid(),
    CLOUDS.map((c) => cloud(c.x, c.y, c.s)).join(''),
    arcs(),
    TARGETS.map((i) => reticle(PIECES[i].x, PIECES[i].y)).join(''),
    pieces(),
  ];

  let body = '';
  layers.forEach((layer, n) => {
    body += `<g id="l${n}">${layer}</g>`;
    // The eight neighbouring copies that make the tile seamless.
    for (const dx of [-TILE_W, 0, TILE_W]) {
      for (const dy of [-TILE_H, 0, TILE_H]) {
        if (dx || dy) body += `<use href="#l${n}" x="${dx}" y="${dy}"/>`;
      }
    }
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_W}" height="${TILE_H}" viewBox="0 0 ${TILE_W} ${TILE_H}">` +
    `<rect width="${TILE_W}" height="${TILE_H}" fill="${MAP_INK.paper}"/>${body}</svg>`
  );
}

/** The tile as a CSS `url(...)`, ready for `background-image`. */
export function titleTileCss(): string {
  return `url("data:image/svg+xml,${encodeURIComponent(titleTileSvg())}")`;
}
