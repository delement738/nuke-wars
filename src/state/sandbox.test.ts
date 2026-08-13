import { describe, expect, it } from 'vitest';
import { hexKey } from '../sim/hex';
import { generateMap, makeRng } from '../sim/map';
import { nextPlacementKind, validateSetup } from '../sim/setup';
import { PLAYERS } from '../sim/types';
import { sandboxSetup } from './sandbox';

describe('sandboxSetup', () => {
  it('produces a setup the engine calls legal, for both players', () => {
    // Several seeds, because the picks are indexes into a legal-hex list whose
    // length depends on where the generator put mountains.
    for (const seed of [1, 42, 137, 5000]) {
      const map = generateMap(undefined, undefined, seed);
      for (const player of PLAYERS) {
        const setup = sandboxSetup(map, player, makeRng(seed));
        expect(validateSetup(map, player, setup)).toEqual({ legal: true });
      }
    }
  });

  it('places the whole roster, in placement order', () => {
    const map = generateMap();
    const setup = sandboxSetup(map, 'p1', makeRng(1));

    expect(setup.map((p) => p.kind)).toEqual([
      'bunker',
      'decoy',
      'interceptor',
      'interceptor',
    ]);
    expect(nextPlacementKind(setup)).toBeNull();
  });

  it('is reproducible — the same map and seed give the same setup', () => {
    const map = generateMap(undefined, undefined, 99);
    expect(sandboxSetup(map, 'p2', makeRng(7))).toEqual(
      sandboxSetup(map, 'p2', makeRng(7)),
    );
  });

  /**
   * The property the fixed-fraction version did NOT have, and the reason it was
   * replaced in build-order step 10b: the CPU's bunker used to land in the same
   * relative spot on every board, so a human hunting it learned where to point
   * the drone once and the bunker hunt stopped being a hunt (spec §12).
   *
   * Asserted across seeds rather than "is it random", because that is the thing
   * that actually matters — a different board must not imply the same site.
   */
  it('puts the bunker somewhere different on different seeds', () => {
    const sites = new Set<string>();
    for (const seed of [1, 42, 137, 5000, 20250, 61, 900]) {
      const map = generateMap(undefined, undefined, seed);
      const setup = sandboxSetup(map, 'p1', makeRng(seed));
      const bunker = setup.find((p) => p.kind === 'bunker');
      sites.add(hexKey(bunker!.hex));
    }
    expect(sites.size).toBeGreaterThan(1);
  });

  /**
   * Two seeds on ONE board must disagree. This is the sharper version of the
   * test above: it isolates the placement from the map, so a "randomisation"
   * that merely followed the terrain around would fail here while passing there.
   */
  it('puts the bunker somewhere different on different seeds, same board', () => {
    const map = generateMap(undefined, undefined, 42);
    const sites = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => {
        const setup = sandboxSetup(map, 'p1', makeRng(seed));
        return hexKey(setup.find((p) => p.kind === 'bunker')!.hex);
      }),
    );
    expect(sites.size).toBeGreaterThan(1);
  });

  it('never stacks two assets on one hex', () => {
    const map = generateMap();
    const hexes = sandboxSetup(map, 'p1', makeRng(3)).map((p) => hexKey(p.hex));
    expect(new Set(hexes).size).toBe(hexes.length);
  });

  /**
   * Draws every asset from the stream it was given, and nothing else — no
   * `Math.random()` anywhere. A caller that supplies a seeded rng gets a
   * reproducible sandbox, which is the whole reason the parameter exists.
   */
  it('takes all its randomness from the supplied rng', () => {
    const map = generateMap();
    let calls = 0;
    const rng = makeRng(11);
    const counted = () => {
      calls += 1;
      return rng();
    };

    const setup = sandboxSetup(map, 'p1', counted);
    expect(calls).toBe(setup.length);
  });
});
