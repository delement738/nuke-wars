import { describe, expect, it } from 'vitest';
import { UNIT_DEFS } from '../sim/defs';
import type { UnitKind } from '../sim/types';
import { EMBLEM, EMBLEM_BOX, emblemPaths } from './emblems';
// The file's own text, through Vite, for the import check below.
import source from './emblems.ts?raw';

const KINDS = Object.keys(UNIT_DEFS) as UnitKind[];

/** Even-odd ray cast: is (x, y) inside the flat polygon `p`? */
function inside(p: readonly number[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const [xi, yi, xj, yj] = [p[i], p[i + 1], p[j], p[j + 1]];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Sample points across the box, nudged off the half-unit grid the shapes are drawn on. */
function* samples(step = 0.25): Generator<[number, number]> {
  const half = EMBLEM_BOX / 2;
  for (let x = -half; x <= half; x += step) {
    for (let y = -half; y <= half; y += step) yield [x + 0.013, y + 0.017];
  }
}

describe('unit emblems', () => {
  it('has an emblem for every unit kind', () => {
    for (const kind of KINDS) expect(EMBLEM[kind].length).toBeGreaterThan(0);
  });

  it('keeps every emblem inside its box, as whole points', () => {
    const half = EMBLEM_BOX / 2;
    for (const kind of KINDS) {
      for (const shape of EMBLEM[kind]) {
        for (const points of [shape.poly, shape.hole ?? []]) {
          expect(points.length % 2).toBe(0);
          for (const v of points) expect(Math.abs(v)).toBeLessThanOrEqual(half);
        }
      }
    }
  });

  // Pixi's `cut()` fails silently when a hole pokes outside its shape.
  it('puts every hole wholly inside its shape', () => {
    for (const kind of KINDS) {
      for (const { poly, hole } of EMBLEM[kind]) {
        if (!hole) continue;
        for (let i = 0; i < hole.length; i += 2) expect(inside(poly, hole[i], hole[i + 1])).toBe(true);
      }
    }
  });

  // Pixi applies alpha shape by shape, so an overlap would be a darker patch on
  // a faint recon contact or a greyed wreck.
  it('never overlaps two shapes of one emblem', () => {
    for (const kind of KINDS) {
      const shapes = EMBLEM[kind];
      for (const [x, y] of samples()) {
        const covering = shapes.filter((s) => inside(s.poly, x, y)).length;
        expect(covering, `${kind} at ${x}, ${y}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('draws your own decoy differently from your own bunker', () => {
    let differ = 0;
    const filled = (kind: UnitKind, x: number, y: number) =>
      EMBLEM[kind].some((s) => inside(s.poly, x, y) && !(s.hole && inside(s.hole, x, y)));
    for (const [x, y] of samples()) if (filled('bunker', x, y) !== filled('decoy', x, y)) differ++;
    // A clear difference, not a detail: at least a third of the bunker's area.
    // That is the hollow; a missing doorway alone is too small to tell apart.
    let bunkerArea = 0;
    for (const [x, y] of samples()) if (filled('bunker', x, y)) bunkerArea++;
    expect(differ).toBeGreaterThan(bunkerArea / 3);
  });

  it('gives the legend one SVG path per shape, a hole as a second ring', () => {
    for (const kind of KINDS) {
      const paths = emblemPaths(kind);
      expect(paths).toHaveLength(EMBLEM[kind].length);
      EMBLEM[kind].forEach((shape, i) => {
        expect(paths[i].match(/M/g)).toHaveLength(shape.hole ? 2 : 1);
      });
    }
  });

  // The UI reads this file for the legend; it must not drag the renderer in.
  it('imports nothing but types, so the UI can read it', () => {
    const imports = source.match(/^import .*$/gm) ?? [];
    for (const line of imports) expect(line).toMatch(/^import type /);
  });
});
