import { describe, expect, it } from 'vitest';
import { distance, hexesInRange, hexLine, neighbors, type Hex } from './hex';

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

describe('hexLine', () => {
  it('a hex to itself is a single-hex line', () => {
    // Not an error: "the drone may not fly to its own hex" (spec §11) is a
    // validation rule, not a geometric one. The primitive stays rule-free.
    expect(hexLine(ORIGIN, ORIGIN)).toEqual([ORIGIN]);
    expect(hexLine({ q: 4, r: -7 }, { q: 4, r: -7 })).toEqual([{ q: 4, r: -7 }]);
  });

  it('adjacent hexes give just the two endpoints', () => {
    for (const n of neighbors(ORIGIN)) {
      expect(hexLine(ORIGIN, n)).toEqual([ORIGIN, n]);
    }
  });

  it('walks the three hex axes as straight runs', () => {
    // +q (east), +r (south-ish), and the q/r diagonal that holds s constant.
    expect(hexLine(ORIGIN, { q: 4, r: 0 })).toEqual([
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 2, r: 0 },
      { q: 3, r: 0 },
      { q: 4, r: 0 },
    ]);
    expect(hexLine(ORIGIN, { q: 0, r: 4 })).toEqual([
      { q: 0, r: 0 },
      { q: 0, r: 1 },
      { q: 0, r: 2 },
      { q: 0, r: 3 },
      { q: 0, r: 4 },
    ]);
    expect(hexLine(ORIGIN, { q: 4, r: -4 })).toEqual([
      { q: 0, r: 0 },
      { q: 1, r: -1 },
      { q: 2, r: -2 },
      { q: 3, r: -3 },
      { q: 4, r: -4 },
    ]);
  });

  it('breaks grazing ties deterministically (spec §10 epsilon nudge)', () => {
    // (0,0) -> (1,1) passes exactly through the corner shared by (1,0) and
    // (0,1): both are one step from each endpoint and nothing in the geometry
    // prefers either. The pinned (+1e-6, +2e-6) nudge picks one, and these
    // literals lock that choice in — a refactor that flips a coin here would
    // desync the sim, the UI preview and the V1.5 server.
    expect(hexLine(ORIGIN, { q: 1, r: 1 })).toEqual([
      { q: 0, r: 0 },
      { q: 0, r: 1 },
      { q: 1, r: 1 },
    ]);
    expect(hexLine(ORIGIN, { q: -1, r: -1 })).toEqual([
      { q: 0, r: 0 },
      { q: -1, r: 0 },
      { q: -1, r: -1 },
    ]);
    expect(hexLine(ORIGIN, { q: 2, r: 2 })).toEqual([
      { q: 0, r: 0 },
      { q: 0, r: 1 },
      { q: 1, r: 1 },
      { q: 1, r: 2 },
      { q: 2, r: 2 },
    ]);
  });

  it('never returns a negative-zero coordinate', () => {
    // Math.round(-0.4) is -0, and -0 is not deep-equal to 0, so a stray one
    // would make identical hexes compare as different and break the
    // determinism checks that deep-equal whole resolved states (spec §6).
    for (const b of hexesInRange(ORIGIN, 6)) {
      for (const h of hexLine(ORIGIN, b)) {
        expect(Object.is(h.q, -0)).toBe(false);
        expect(Object.is(h.r, -0)).toBe(false);
      }
    }
  });

  it('is deterministic — the same call returns the same path', () => {
    const a: Hex = { q: -3, r: 5 };
    const b: Hex = { q: 2, r: 1 };
    expect(hexLine(a, b)).toEqual(hexLine(a, b));
  });

  it('holds its invariants for every pair within missile range', () => {
    // 6 is the missile/drone range (RULES in defs.ts); hex.ts stays
    // dependency-free, so the number is repeated rather than imported.
    const disc = hexesInRange(ORIGIN, 6);
    let pairsChecked = 0;

    for (const a of disc) {
      for (const b of disc) {
        const steps = distance(a, b);
        if (steps > 6) continue;
        pairsChecked++;

        const line = hexLine(a, b);

        // Both endpoints are included, so a distance-N line is N+1 hexes.
        expect(line).toHaveLength(steps + 1);
        expect(line[0]).toEqual(a);
        expect(line[line.length - 1]).toEqual(b);

        // Every hop is exactly one step, and every hop makes progress: hex i is
        // i steps from the start and steps-i from the end. Together these mean
        // the path never doubles back, stalls, or teleports — which is what
        // lets the interception loop treat index as elapsed time.
        for (let i = 0; i < line.length; i++) {
          expect(distance(a, line[i])).toBe(i);
          expect(distance(line[i], b)).toBe(steps - i);
          if (i > 0) expect(distance(line[i - 1], line[i])).toBe(1);
        }

        // No repeats — a missile must not be checked for interception twice on
        // the same hex.
        const keys = line.map((h) => `${h.q},${h.r}`);
        expect(new Set(keys).size).toBe(keys.length);
      }
    }

    expect(pairsChecked).toBeGreaterThan(9000);
  });

  it('is reversible for every pair within missile range', () => {
    // Guaranteed by nudging both endpoints by the same offset (spec §10): the
    // tilt is constant along the line, so direction cannot change the result.
    const disc = hexesInRange(ORIGIN, 6);
    for (const a of disc) {
      for (const b of disc) {
        if (distance(a, b) > 6) continue;
        expect(hexLine(a, b)).toEqual([...hexLine(b, a)].reverse());
      }
    }
  });
});
