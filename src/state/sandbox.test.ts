import { describe, expect, it } from 'vitest';
import { RULES } from '../sim/defs';
import { hexKey } from '../sim/hex';
import { generateMap } from '../sim/map';
import { PLACEMENT_ORDER, validateSetup } from '../sim/setup';
import { PLAYERS } from '../sim/types';
import { SANDBOX_PICKS, sandboxSetup } from './sandbox';

describe('sandboxSetup', () => {
  it('produces a setup the engine calls legal, for both players', () => {
    // Several seeds, because the picks are indexes into a legal-hex list whose
    // length depends on where the generator put mountains.
    for (const seed of [1, 42, 137, 5000]) {
      const map = generateMap(undefined, undefined, seed);
      for (const player of PLAYERS) {
        expect(validateSetup(map, player, sandboxSetup(map, player))).toEqual({
          legal: true,
        });
      }
    }
  });

  it('places the whole roster, in placement order', () => {
    const map = generateMap();
    const setup = sandboxSetup(map, 'p1');

    expect(setup.map((p) => p.kind)).toEqual([
      'bunker',
      'decoy',
      'interceptor',
      'interceptor',
    ]);
  });

  it('is deterministic — the same map gives the same setup', () => {
    const map = generateMap(undefined, undefined, 99);
    expect(sandboxSetup(map, 'p2')).toEqual(sandboxSetup(map, 'p2'));
  });

  it('never stacks two assets on one hex', () => {
    const map = generateMap();
    const hexes = sandboxSetup(map, 'p1').map((p) => hexKey(p.hex));
    expect(new Set(hexes).size).toBe(hexes.length);
  });

  // The invariant SANDBOX_PICKS exists to hold: one fraction per asset placed.
  // Adding a placeable kind to the roster fails here rather than reading an
  // undefined fraction at runtime.
  it('has one pick per asset in RULES.placementCounts', () => {
    for (const kind of PLACEMENT_ORDER) {
      expect(SANDBOX_PICKS[kind]).toHaveLength(RULES.placementCounts[kind]);
    }
    expect(Object.keys(SANDBOX_PICKS).sort()).toEqual(
      Object.keys(RULES.placementCounts).sort(),
    );
  });
});
