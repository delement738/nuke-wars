// RENDER LAYER — the unit emblems, as plain data (presentation, unit emblems).
//
// One picture per unit kind, read by two painters: the Pixi board (`emblemAt` in
// `./draw`) and the how-to-play legend (`HowToPlay.tsx`, as SVG paths). Keeping
// the shapes here, once, is the point — a board and a key drawn from two copies
// drift apart (gotcha 71).
//
// **This file imports no Pixi and no React**, only a type, so the UI layer can
// read it without pulling the renderer in. `emblems.test.ts` pins that.
//
// Rules the art keeps (spec §11, §12; gotchas 8, 31, 69):
//   - An emblem is chosen from a piece's kind and nothing else — never from its
//     hit points, a kill, or anything in the event log.
//   - There is a 'decoy' emblem, but only the viewer's own decoy can ever be
//     drawn with it: enemy intel is typed `MaskedStaticKind`, which has no
//     'decoy', so an enemy site can only be drawn as a bunker.
//
// Format: each emblem is a list of shapes in a 24 × 24 box centred on 0, y down.
// A shape may carry one `hole`, which must lie wholly inside it (Pixi's `cut()`
// fails otherwise). Shapes within one emblem may touch but never overlap: Pixi
// applies a Graphics' alpha shape by shape, so an overlap would show as a darker
// patch on a faint contact.

import type { UnitKind } from '../sim/types';

/** Side of the square every emblem is drawn in, in emblem units. */
export const EMBLEM_BOX = 24;

/** A polygon as flat [x0, y0, x1, y1, ...], with an optional hole inside it. */
export interface EmblemShape {
  readonly poly: readonly number[];
  readonly hole?: readonly number[];
}

export const EMBLEM: Record<UnitKind, readonly EmblemShape[]> = {
  // A missile at 45° on a strut and a ground rail.
  launcher: [
    { poly: [-11, 7, 11, 7, 11, 10, -11, 10] },
    { poly: [-1, 7, 2, -1.4, 5, 7] },
    { poly: [-2.7, 6.3, -1.8, 2.2, 6.3, -5.9, 9, -12, 2.9, -9.3, -5.2, -1.2, -9.3, -0.3] },
  ],
  // A missile standing upright on its pad: defence points straight up.
  interceptor: [
    { poly: [-10, 10, -5, 4, -2.5, 0, -2.5, -5.5, 0, -12, 2.5, -5.5, 2.5, 0, 5, 4, 10, 10] },
  ],
  // A plane seen from above.
  drone: [
    {
      poly: [
        0, -11, 2, -7.5, 2, -3, 11.5, 0, 11.5, 2.5, 2, 1.2, 2, 6.5, 5, 6.5, 5, 9.5,
        -5, 9.5, -5, 6.5, -2, 6.5, -2, 1.2, -11.5, 2.5, -11.5, 0, -2, -3, -2, -7.5,
      ],
    },
  ],
  // A solid arch with a doorway.
  bunker: [
    { poly: [-11, 8, -11, -1, -6, -7, 6, -7, 11, -1, 11, 8, 4, 8, 4, 1, -4, 1, -4, 8] },
  ],
  // The bunker's outline, hollow: an empty shell. Only ever the viewer's own.
  decoy: [
    {
      poly: [-11, 8, -11, -1, -6, -7, 6, -7, 11, -1, 11, 8],
      hole: [-8, 5, -8, 0, -4.6, -4, 4.6, -4, 8, 0, 8, 5],
    },
  ],
};

function ring(points: readonly number[]): string {
  let d = '';
  for (let i = 0; i < points.length; i += 2) d += `${i ? 'L' : 'M'}${points[i]} ${points[i + 1]}`;
  return `${d}Z`;
}

/**
 * The emblem as SVG path data, one string per shape, in emblem units. Draw each
 * as its own `<path fill-rule="evenodd">`: evenodd is what makes a `hole` a
 * hole, and one path per shape keeps it from punching through a neighbour.
 */
export function emblemPaths(kind: UnitKind): string[] {
  return EMBLEM[kind].map((shape) => ring(shape.poly) + (shape.hole ? ring(shape.hole) : ''));
}
