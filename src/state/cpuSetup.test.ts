import { describe, expect, it } from 'vitest';
import { RULES } from '../sim/defs';
import { axialToOffset, distance, hexLine, offsetToAxial, type Hex } from '../sim/hex';
import { generateMap, makeRng } from '../sim/map';
import { validateSetup } from '../sim/setup';
import { PLAYERS, type PlayerId } from '../sim/types';
import { HARD_SITE_GAP_MAX, cpuSetup } from './cpuSetup';
import { sandboxSetup } from './sandbox';

const SEEDS = Array.from({ length: 200 }, (_, i) => 1000 + i);

const boardCache = new Map<PlayerId, ReturnType<typeof buildBoards>>();

/** 200 HARD setups per player — built once, since four tests read them. */
function hardBoards(player: PlayerId) {
  if (!boardCache.has(player)) boardCache.set(player, buildBoards(player));
  return boardCache.get(player)!;
}

function buildBoards(player: PlayerId) {
  return SEEDS.map((seed) => {
    const map = generateMap(undefined, undefined, seed);
    const [bunker, decoy, base] = cpuSetup(map, player, 'hard', makeRng(seed)).map((p) => p.hex);
    return { map, seed, bunker, decoy, base };
  });
}

/**
 * Whether a missile fired straight down the board at `site` — from the same
 * column, `missileRange` rows toward the enemy — would cross `base`'s bubble.
 * An independent model of "the approach", deliberately not the lane set
 * `cpuSetup` scores with, so the test is not the implementation restated.
 */
function straightShotCovered(player: PlayerId, site: Hex, base: Hex): boolean {
  const { col, row } = axialToOffset(site);
  const originRow = player === 'p1' ? row - RULES.missileRange : row + RULES.missileRange;
  const origin = offsetToAxial({ col, row: originRow });
  return hexLine(origin, site)
    .slice(1)
    .some((hex) => distance(hex, base) <= RULES.interceptorCoverageRadius);
}

describe('cpuSetup', () => {
  it('is legal for every tier and both players', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const map = generateMap(undefined, undefined, seed);
      for (const player of PLAYERS) {
        for (const tier of ['easy', 'medium', 'hard'] as const) {
          const setup = cpuSetup(map, player, tier, makeRng(seed));
          expect(validateSetup(map, player, setup)).toEqual({ legal: true });
        }
      }
    }
  });

  it('leaves EASY and MEDIUM on the plain fixture — same stream, same board', () => {
    const map = generateMap(undefined, undefined, 5);
    for (const tier of ['easy', 'medium'] as const) {
      expect(cpuSetup(map, 'p2', tier, makeRng(9))).toEqual(sandboxSetup(map, 'p2', makeRng(9)));
    }
  });

  it('is reproducible', () => {
    const map = generateMap(undefined, undefined, 77);
    expect(cpuSetup(map, 'p1', 'hard', makeRng(3))).toEqual(
      cpuSetup(map, 'p1', 'hard', makeRng(3)),
    );
  });

  it('HARD puts its base across the straight approach to its sites', () => {
    // The fixture's random base is the control: the same boards, the same shot.
    for (const player of PLAYERS) {
      let hard = 0;
      let fixture = 0;
      for (const { map, seed, bunker, decoy, base } of hardBoards(player)) {
        for (const site of [bunker, decoy]) if (straightShotCovered(player, site, base)) hard++;

        const [b, d, randomBase] = sandboxSetup(map, player, makeRng(seed)).map((p) => p.hex);
        for (const site of [b, d]) if (straightShotCovered(player, site, randomBase)) fixture++;
      }
      const shots = SEEDS.length * 2;
      // Measured 2026-09-27: HARD ~0.31, fixture ~0.10. The straight shot is one
      // lane of the arc HARD scores, and a site in the front rows leaves no legal
      // hex in front of it, so the bar is "clearly better than random", not "always".
      expect(hard / shots).toBeGreaterThan(0.22);
      expect(fixture / shots).toBeLessThan(0.16);
    }
  });

  /**
   * §12's indistinguishability principle. The base goes public the first time
   * it intercepts (`BASE_EXPOSED`), so if it sat systematically nearer one kind
   * of site, an exposed base would tell the enemy which of two found sites is
   * real. Over 400 boards a fair coin lands 44–56% about 98% of the time.
   */
  it('HARD’s base is no nearer the bunker than the decoy', () => {
    let nearerBunker = 0;
    let decided = 0;
    let bunkerDistance = 0;
    let decoyDistance = 0;
    for (const player of PLAYERS) {
      for (const { bunker, decoy, base } of hardBoards(player)) {
        const b = distance(base, bunker);
        const d = distance(base, decoy);
        bunkerDistance += b;
        decoyDistance += d;
        if (b !== d) decided++;
        if (b < d) nearerBunker++;
      }
    }
    expect(nearerBunker / decided).toBeGreaterThan(0.4);
    expect(nearerBunker / decided).toBeLessThan(0.6);
    expect(Math.abs(bunkerDistance - decoyDistance) / (SEEDS.length * 2)).toBeLessThan(0.3);
  });

  /** Gotchas 43–45: the bunker hunt must stay a hunt. */
  it('HARD’s bunker still lands all over the home zone', () => {
    for (const player of PLAYERS) {
      const zone = RULES.homeZoneRows[player];
      const rows = new Set<number>();
      const cols = new Set<number>();
      for (const { bunker, decoy } of hardBoards(player)) {
        const { col, row } = axialToOffset(bunker);
        rows.add(row);
        cols.add(col);
        expect(distance(bunker, decoy)).toBeLessThanOrEqual(HARD_SITE_GAP_MAX);
      }
      expect(rows.size).toBe(zone.max - zone.min + 1);
      expect(cols.size).toBe(16);
    }
  });
});
