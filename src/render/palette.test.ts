import { describe, expect, it } from 'vitest';
import { PALETTE, css } from './palette';

/** WCAG relative luminance of a 0xRRGGBB colour. */
function luminance(n: number): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

function contrast(a: number, b: number): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('board palette', () => {
  it('writes CSS the legend can use', () => {
    expect(css('enemy')).toBe('#b3362a');
    expect(css('own', 0.25)).toBe('rgba(47, 111, 196, 0.25)');
    expect(css('seen')).toBe('#ffffff');
  });

  // The board went from dark to paper in V1.5 Session 3; every colour that
  // marks something must still read against the ground it is drawn on.
  it('keeps every mark readable on paper and on the hills', () => {
    const marks = ['own', 'enemy', 'ink', 'move', 'march', 'launch', 'fly', 'place'] as const;
    for (const name of marks) {
      expect(contrast(PALETTE[name], PALETTE.paper), name).toBeGreaterThan(2.2);
      expect(contrast(PALETTE[name], PALETTE.hill), name).toBeGreaterThan(1.9);
    }
  });

  it('draws your emblem clearly on your own plate', () => {
    expect(contrast(PALETTE.glyph, PALETTE.own)).toBeGreaterThan(4);
  });
});
