// UI LAYER — what each mark on the board means (presentation Session 4).
//
// One list, read by two screens: the HUD's Legend panel prints the lines, and
// the how-to-play screen's "Reading the board" section prints the same lines
// with a colour sample beside each. Keeping them in one place is the whole
// point — two copies of a legend are two chances for one of them to describe a
// board that no longer exists.
//
// Every line must describe only what the viewer already knows (gotchas 20, 60,
// 70). In particular a spotted site is always "a bunker site": the legend may
// never suggest the board can tell the real bunker from the decoy.

import { RULES } from '../sim/defs';

/** Which HUD colour class a line is printed in (`hud.css`). */
export type LegendTone = 'own' | 'enemy' | 'muted';

/**
 * A small picture of the mark, for the how-to-play screen. Colours match
 * `COLOR` in `src/render/draw.ts` — a sample that names a colour has to be
 * drawn in it, or it is just a sentence.
 */
export interface LegendSwatch {
  fill?: string;
  border?: string;
  shape: 'hex' | 'ring' | 'target';
  glyph?: string;
}

export interface LegendEntry {
  tone: LegendTone;
  swatch: LegendSwatch;
  text: string;
}

const R = RULES.interceptorCoverageRadius;

/** The in-game legend. The setup screen keeps its own, which is about placing. */
export const LEGEND: readonly LegendEntry[] = [
  {
    tone: 'own',
    swatch: { shape: 'hex', fill: '#5aa9ff', glyph: 'L' },
    text: 'Blue — your units: L launcher, I interceptor base, D drone, B bunker, X decoy.',
  },
  {
    tone: 'muted',
    swatch: { shape: 'hex', fill: '#4ad991' },
    text: 'Orders: green — where a launcher can move (brighter: march). Amber outline — where it can fire. Violet dots — where the drone can fly.',
  },
  {
    tone: 'enemy',
    swatch: { shape: 'hex', border: '#ff5f4a', glyph: 'B' },
    text: 'Red outline: an enemy bunker site (B) or base (I), marked for good. A site always shows as B — it may be the decoy.',
  },
  {
    tone: 'enemy',
    swatch: { shape: 'ring', border: '#ff5f4a', glyph: 'L' },
    text: 'Red circle: an enemy launcher, this round only. Bright: it fired from there and is still there. Faint: it may have moved.',
  },
  {
    tone: 'enemy',
    swatch: { shape: 'hex', fill: 'rgba(255, 95, 74, 0.25)', border: '#ff5f4a' },
    text: 'Red hex under your own launcher: its forced march will tell the enemy this hex.',
  },
  {
    tone: 'muted',
    swatch: { shape: 'target', border: '#ff5f4a' },
    text: 'Crosshair and dashed line: a missile in the air and where it lands. Red INBOUND is theirs; amber YOUR STRIKE is yours.',
  },
  {
    tone: 'muted',
    swatch: { shape: 'hex', fill: 'rgba(90, 169, 255, 0.25)' },
    text: 'Faint blue wash: ground your interceptor base covers.',
  },
  {
    tone: 'muted',
    swatch: { shape: 'hex', fill: 'rgba(255, 255, 255, 0.18)' },
    text: 'Lighter ground: photographed by your drone, so any site there is already marked.',
  },
  {
    tone: 'enemy',
    swatch: { shape: 'hex', fill: 'rgba(255, 95, 74, 0.3)', border: '#ff5f4a', glyph: 'I?' },
    text: `Red hexes marked I? (sometimes just one): the enemy base is on one of them — within ${R} of where your drone was shot down.`,
  },
];
