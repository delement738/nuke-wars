import { describe, expect, it } from 'vitest';
import { distance, hexesInRange, neighbors, type Hex } from './hex';

const ORIGIN: Hex = { q: 0, r: 0 };

describe('distance', () => {
  it('is zero for a hex and itself', () => {
    expect(distance(ORIGIN, ORIGIN)).toBe(0);
  });

  it('is one for adjacent hexes', () => {
    for (const n of neighbors(ORIGIN)) {
      expect(distance(ORIGIN, n)).toBe(1);
    }
  });

  it('is symmetric', () => {
    const a: Hex = { q: 3, r: -2 };
    const b: Hex = { q: -1, r: 4 };
    expect(distance(a, b)).toBe(distance(b, a));
  });

  it('matches the known redblobgames example', () => {
    // (0,0) to (3,-1): dq=3, dr=-1 -> (3 + 1 + 2) / 2 = 3
    expect(distance(ORIGIN, { q: 3, r: -1 })).toBe(3);
  });

  it('handles a pure q-axis walk', () => {
    expect(distance(ORIGIN, { q: 5, r: 0 })).toBe(5);
  });
});

describe('neighbors', () => {
  it('returns exactly six hexes', () => {
    expect(neighbors(ORIGIN)).toHaveLength(6);
  });

  it('returns distinct hexes', () => {
    const keys = neighbors(ORIGIN).map((h) => `${h.q},${h.r}`);
    expect(new Set(keys).size).toBe(6);
  });

  it('are all exactly one step away', () => {
    for (const n of neighbors({ q: 2, r: -3 })) {
      expect(distance({ q: 2, r: -3 }, n)).toBe(1);
    }
  });

  it('is translation-invariant (shape is the same everywhere on the grid)', () => {
    const offset: Hex = { q: 7, r: -4 };
    const shifted = neighbors(offset)
      .map((h) => ({ q: h.q - offset.q, r: h.r - offset.r }))
      .sort((a, b) => a.q - b.q || a.r - b.r);
    const base = neighbors(ORIGIN).sort((a, b) => a.q - b.q || a.r - b.r);
    expect(shifted).toEqual(base);
  });
});

describe('hexesInRange', () => {
  it('range 0 returns only the center', () => {
    expect(hexesInRange(ORIGIN, 0)).toEqual([ORIGIN]);
  });

  it('range 1 returns the center plus its six neighbors', () => {
    const result = hexesInRange(ORIGIN, 1);
    expect(result).toHaveLength(7);
    const keys = new Set(result.map((h) => `${h.q},${h.r}`));
    expect(keys.has('0,0')).toBe(true);
    for (const n of neighbors(ORIGIN)) {
      expect(keys.has(`${n.q},${n.r}`)).toBe(true);
    }
  });

  it('follows the hex "centered polygon" count: 1 + 3*n*(n+1)', () => {
    for (let n = 0; n <= 5; n++) {
      expect(hexesInRange(ORIGIN, n)).toHaveLength(1 + 3 * n * (n + 1));
    }
  });

  it('every returned hex is within `range` steps of center', () => {
    const range = 4;
    for (const h of hexesInRange(ORIGIN, range)) {
      expect(distance(ORIGIN, h)).toBeLessThanOrEqual(range);
    }
  });

  it('contains no duplicates', () => {
    const result = hexesInRange({ q: -2, r: 5 }, 3);
    const keys = result.map((h) => `${h.q},${h.r}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
