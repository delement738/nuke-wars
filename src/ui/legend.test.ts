import { describe, expect, it } from 'vitest';
import { UNIT_DEFS } from '../sim/defs';
import type { UnitKind } from '../sim/types';
import { LEGEND } from './legend';

const KINDS = Object.keys(UNIT_DEFS) as UnitKind[];

describe('legend emblems', () => {
  it('shows every one of your unit kinds', () => {
    const own = LEGEND.filter((e) => e.tone === 'own').flatMap((e) => e.swatches);
    for (const kind of KINDS) expect(own.map((s) => s.emblem)).toContain(kind);
  });

  // An enemy site is always drawn as a bunker (spec §12): the key must never
  // suggest the board can show an enemy decoy.
  it('never draws an enemy mark with the decoy emblem', () => {
    const enemy = LEGEND.filter((e) => e.tone === 'enemy').flatMap((e) => e.swatches);
    expect(enemy.some((s) => s.emblem !== undefined)).toBe(true);
    for (const swatch of enemy) expect(swatch.emblem).not.toBe('decoy');
  });

  it('names no unit by a letter any more', () => {
    for (const { text } of LEGEND) expect(text).not.toMatch(/\b[LIDBX]\b|I\?/);
  });
});
