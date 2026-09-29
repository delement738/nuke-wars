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

import { css } from '../render/palette';
import { RULES } from '../sim/defs';
import type { UnitKind } from '../sim/types';

/** Which HUD colour class a line is printed in (`hud.css`). */
export type LegendTone = 'own' | 'enemy' | 'muted';

/**
 * A small picture of the mark, for the how-to-play screen. Colours come from
 * `PALETTE` in `src/render/palette.ts`, as the board's `COLOR` does — a sample that names a colour has to be
 * drawn in it, or it is just a sentence. The emblem is drawn from the same
 * shapes as the board (`src/render/emblems.ts`), never a copy.
 */
export interface LegendSwatch {
  fill?: string;
  border?: string;
  shape: 'hex' | 'ring' | 'target';
  emblem?: UnitKind;
  /** A deduction, not a sighting: the emblem small and faded, beside a "?". */
  guess?: boolean;
  /** Whole-sample opacity, as a destroyed piece is drawn. */
  opacity?: number;
  /** Names the sample on hover. */
  label?: string;
}

export interface LegendEntry {
  tone: LegendTone;
  /** Usually one; a line naming several marks shows them in the order it names them. */
  swatches: readonly LegendSwatch[];
  text: string;
}

const OWN = css('own');
const OWN_DESTROYED = css('ownDestroyed');
const ENEMY = css('enemy');

const own = (emblem: UnitKind, label: string): LegendSwatch => ({
  shape: 'hex',
  fill: OWN,
  emblem,
  label,
});

const R = RULES.interceptorCoverageRadius;

/** The in-game legend. The setup screen keeps its own, which is about placing. */
export const LEGEND: readonly LegendEntry[] = [
  {
    tone: 'own',
    swatches: [
      own('launcher', 'Launcher'),
      own('interceptor', 'Interceptor base'),
      own('drone', 'Drone'),
      own('bunker', 'Bunker'),
      own('decoy', 'Decoy'),
      { shape: 'hex', fill: OWN_DESTROYED, opacity: 0.55, emblem: 'launcher', label: 'Destroyed' },
    ],
    text: 'Blue — your units: launcher, interceptor base, drone, bunker, decoy (a hollow bunker). Grey: destroyed.',
  },
  {
    tone: 'muted',
    swatches: [{ shape: 'hex', fill: css('move') }],
    text: 'Orders: green — where a launcher can move (olive: march). Orange outline — where it can fire. Violet dots — where the drone can fly.',
  },
  {
    tone: 'enemy',
    swatches: [
      { shape: 'hex', border: ENEMY, emblem: 'bunker', label: 'Enemy bunker site' },
      { shape: 'hex', border: ENEMY, emblem: 'interceptor', label: 'Enemy base' },
    ],
    text: 'Red outline: an enemy bunker site or base, marked for good. Every site looks like a bunker — it may be the decoy.',
  },
  {
    tone: 'enemy',
    swatches: [{ shape: 'ring', border: ENEMY, emblem: 'launcher', label: 'Enemy launcher' }],
    text: 'Red circle: an enemy launcher, this round only. Bright: it fired from there and is still there. Faint: it may have moved.',
  },
  {
    tone: 'enemy',
    swatches: [{ shape: 'hex', fill: css('enemy', 0.25), border: ENEMY }],
    text: 'Red hex under your own launcher: its forced march will tell the enemy this hex.',
  },
  {
    tone: 'muted',
    swatches: [{ shape: 'target', border: ENEMY }],
    text: 'Crosshair and dashed line: a missile in the air and where it lands. Red INBOUND is theirs; orange YOUR STRIKE is yours.',
  },
  {
    tone: 'muted',
    swatches: [{ shape: 'hex', fill: css('own', 0.25) }],
    text: 'Faint blue wash: ground your interceptor base covers.',
  },
  {
    tone: 'muted',
    swatches: [{ shape: 'hex', fill: css('seen', 0.55) }],
    text: 'Lighter ground: photographed by your drone, so any site there is already marked.',
  },
  {
    tone: 'enemy',
    swatches: [
      {
        shape: 'hex',
        fill: css('enemy', 0.3),
        border: ENEMY,
        emblem: 'interceptor',
        guess: true,
        label: 'Where the enemy base could be',
      },
    ],
    text: `Red hexes marked base? (sometimes just one): the enemy base is on one of them — within ${R} of where your drone was shot down.`,
  },
];
