// RENDER LAYER — the board's colours, as plain data (V1.5 Session 3, board art).
//
// The paper plotting table from `docs/art-direction.md`: cream map paper, green
// hills marked with peak symbols, ink outlines, and the two sides in blue (yours) and
// stencil red (what you have detected of theirs).
//
// Read by two painters, like `./emblems`: the Pixi board (`COLOR` in `./draw`)
// and the how-to-play legend (`src/ui/legend.ts`, via `css`). One table, so a
// legend sample can never drift from the mark it names.
//
// **This file imports nothing.** The UI layer may read it without pulling in
// Pixi.
//
// Every colour below was chosen against the PAPER ground, not the old dark
// board: highlight hues are deeper and their washes a little stronger, so they
// still stand out on a light map.

export const PALETTE = {
  // Ground.
  paper: 0xe4dec6, // plains
  // Khaki, not the title map's green: green on this board means "you may move
  // here", and a green hill beside a green move wash read as the same thing.
  hill: 0xd6c7a0, // mountain fill
  contour: 0x9c8660, // the peak symbols on a mountain
  grid: 0xb4ac8e, // hex edges
  table: 0x0b0f14, // the bunker around the board

  // Pieces.
  own: 0x2f6fc4,
  ownDestroyed: 0x8d8878,
  enemy: 0xb3362a,
  ink: 0x29251f, // outlines, the selection ring
  glyph: 0xf3efe0, // an emblem on your own blue plate

  // Order builder.
  move: 0x1f8f55,
  march: 0x5f8f00,
  launch: 0xd46a12,
  fly: 0x7a45c9,
  hold: 0x5f5b50,

  // Setup.
  place: 0xb47a00,

  // Intel overlay: photographed ground is lit, so paper turns whiter.
  seen: 0xffffff,
} as const;

export type PaletteName = keyof typeof PALETTE;

/** A palette colour as CSS, optionally with an alpha. */
export function css(name: PaletteName, alpha?: number): string {
  const n = PALETTE[name];
  if (alpha === undefined) return `#${n.toString(16).padStart(6, '0')}`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
