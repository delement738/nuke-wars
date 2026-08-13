import { describe, expect, it } from 'vitest';
import { ALL_SPAWN_HEXES, RULES } from '../sim/defs';
import { axialToOffset, distance, hexKey, offsetToAxial, type Hex } from '../sim/hex';
import { generateMap, type MapData } from '../sim/map';
import { validateSetup, type PlayerSetup } from '../sim/setup';
import { PLAYERS, type PlayerId } from '../sim/types';
import {
  ROSTER_SIZE,
  exclusionHexes,
  placementComplete,
  placementStep,
  placementTargets,
  withPlacement,
  withoutLastPlacement,
} from './placement';

const map: MapData = generateMap(undefined, undefined, 42);
const PLAYER: PlayerId = 'p1';

function keysOf(hexes: readonly Hex[]): Set<string> {
  return new Set(hexes.map(hexKey));
}

/** Place `count` assets by taking the first legal hex offered at each step —
 *  the interactive loop, driven by the module's own answers. */
function walk(count: number, player: PlayerId = PLAYER): PlayerSetup {
  let placed: PlayerSetup = [];
  for (let i = 0; i < count; i++) {
    const targets = placementTargets(map, player, placed);
    placed = withPlacement(map, player, placed, targets[0]);
  }
  return placed;
}

// ---------------------------------------------------------------------------
// Where the player is in the sequence
// ---------------------------------------------------------------------------

describe('placementStep', () => {
  it('walks bunker -> decoy -> base 1 -> base 2 -> done', () => {
    const seen = [0, 1, 2, 3].map((n) => placementStep(walk(n)));

    expect(seen.map((s) => s?.kind)).toEqual([
      'bunker',
      'decoy',
      'interceptor',
      'interceptor',
    ]);
    expect(seen.map((s) => s?.ordinal)).toEqual([1, 2, 3, 4]);
    // Only the two bases are numbered within their kind.
    expect(seen.map((s) => `${s?.index}/${s?.ofKind}`)).toEqual([
      '1/1',
      '1/1',
      '1/2',
      '2/2',
    ]);
  });

  it('is null once the roster is full, and that is what complete means', () => {
    const full = walk(ROSTER_SIZE);

    expect(placementStep(full)).toBeNull();
    expect(placementComplete(full)).toBe(true);
    expect(placementComplete(walk(ROSTER_SIZE - 1))).toBe(false);
  });

  it('counts the roster from RULES rather than from a literal', () => {
    expect(ROSTER_SIZE).toBe(
      Object.values(RULES.placementCounts).reduce((a, b) => a + b, 0),
    );
  });
});

// ---------------------------------------------------------------------------
// Legal hexes — the highlight overlay
// ---------------------------------------------------------------------------

describe('placementTargets', () => {
  it('offers only hexes in the placing player’s own home zone', () => {
    for (const player of PLAYERS) {
      const zone = RULES.homeZoneRows[player];
      for (const hex of placementTargets(map, player, [])) {
        const { row } = axialToOffset(hex);
        expect(row).toBeGreaterThanOrEqual(zone.min);
        expect(row).toBeLessThanOrEqual(zone.max);
      }
    }
  });

  it('never offers a spawn hex (spec §12)', () => {
    const spawns = keysOf(ALL_SPAWN_HEXES.map(offsetToAxial));
    for (const player of PLAYERS) {
      for (const hex of placementTargets(map, player, [])) {
        expect(spawns.has(hexKey(hex))).toBe(false);
      }
    }
  });

  /**
   * §12's indistinguishability principle, on the one screen where a player could
   * see it break: the ground offered for the decoy must be the same ground
   * offered for the bunker, minus only the hex the bunker took. If the two
   * differed, every site found on the difference would be provably real.
   */
  it('offers the decoy exactly the bunker’s ground, minus the bunker’s hex', () => {
    const forBunker = placementTargets(map, PLAYER, []);
    const bunkerHex = forBunker[0];
    const placed = withPlacement(map, PLAYER, [], bunkerHex);

    const expected = keysOf(forBunker);
    expected.delete(hexKey(bunkerHex));

    expect(keysOf(placementTargets(map, PLAYER, placed))).toEqual(expected);
  });

  it('withholds ground inside the exclusion radius once both sites are down', () => {
    const sites = walk(2);
    const targets = placementTargets(map, PLAYER, sites);

    for (const hex of targets) {
      for (const site of sites) {
        expect(distance(site.hex, hex)).toBeGreaterThanOrEqual(
          RULES.bunkerExclusionRadius,
        );
      }
    }
    // ...and it withholds something, or the assertion above is vacuous.
    expect(targets.length).toBeLessThan(placementTargets(map, PLAYER, []).length);
  });

  it('is empty once the roster is full — nothing left to highlight', () => {
    expect(placementTargets(map, PLAYER, walk(ROSTER_SIZE))).toEqual([]);
  });

  /**
   * Mountains are legal for all three placed kinds (spec §2, §12, gotcha 7b).
   * `groundPassable` is emphatically NOT the placement test — reading it here
   * would silently forbid mountain sites, and because that rule would apply to
   * bunker and decoy alike it would not even show up as an asymmetry. It would
   * just quietly delete a real strategic option.
   */
  it('offers mountain hexes, not just plains', () => {
    const mountains = new Set(
      map.tiles
        .filter((t) => t.terrain === 'mountain')
        .map((t) => hexKey(offsetToAxial({ col: t.col, row: t.row }))),
    );
    const offered = placementTargets(map, PLAYER, []);

    expect(offered.some((hex) => mountains.has(hexKey(hex)))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Editing the setup
// ---------------------------------------------------------------------------

describe('withPlacement', () => {
  it('appends the current step’s kind', () => {
    const placed = walk(1);
    expect(placed).toHaveLength(1);
    expect(placed[0].kind).toBe('bunker');
  });

  /**
   * The invariant the store leans on: an illegal placement is never stored, and
   * the SAME reference comes back so the caller can tell nothing happened.
   * `startMatch` throws rather than start a match on an illegal board (§12), and
   * the client must never be the reason it does.
   */
  it('refuses an illegal hex and returns the same reference', () => {
    const placed: PlayerSetup = [];
    // Deep in P2's territory — outside this player's home zone entirely.
    const enemyGround = offsetToAxial({ col: 8, row: 1 });

    expect(withPlacement(map, PLAYER, placed, enemyGround)).toBe(placed);
  });

  it('refuses a hex already taken by one of your own placements', () => {
    const sites = walk(2);
    expect(withPlacement(map, PLAYER, sites, sites[0].hex)).toBe(sites);
  });

  it('refuses a base inside the exclusion radius of a site', () => {
    const sites = walk(2);
    // The bunker's own hex is 0 away, so it is certainly inside the radius —
    // and it is refused for two independent reasons, which is fine: the point is
    // that the draft does not grow.
    const tooClose = sites[0].hex;
    expect(withPlacement(map, PLAYER, sites, tooClose)).toBe(sites);
  });

  it('refuses anything at all once the roster is full', () => {
    const full = walk(ROSTER_SIZE);
    const somewhere = placementTargets(map, PLAYER, walk(2))[0];
    expect(withPlacement(map, PLAYER, full, somewhere)).toBe(full);
  });

  /**
   * The end-to-end property: a setup built only through this module is one the
   * engine accepts. Several seeds, because the legal-hex lists depend on where
   * the generator put mountains.
   */
  it('builds a setup the engine calls legal, on every board and for both sides', () => {
    for (const seed of [1, 42, 137, 5000]) {
      const board = generateMap(undefined, undefined, seed);
      for (const player of PLAYERS) {
        let placed: PlayerSetup = [];
        for (let i = 0; i < ROSTER_SIZE; i++) {
          const targets = placementTargets(board, player, placed);
          expect(targets.length).toBeGreaterThan(0);
          placed = withPlacement(board, player, placed, targets[targets.length - 1]);
        }
        expect(validateSetup(board, player, placed)).toEqual({ legal: true });
      }
    }
  });
});

describe('withoutLastPlacement', () => {
  it('takes back the most recent placement only', () => {
    const two = walk(2);
    const one = withoutLastPlacement(two);

    expect(one).toHaveLength(1);
    expect(one[0]).toEqual(two[0]);
  });

  it('returns the same reference when there is nothing to undo', () => {
    const empty: PlayerSetup = [];
    expect(withoutLastPlacement(empty)).toBe(empty);
  });

  it('re-opens the step that was undone', () => {
    expect(placementStep(withoutLastPlacement(walk(2)))?.kind).toBe('decoy');
  });
});

// ---------------------------------------------------------------------------
// The exclusion overlay
// ---------------------------------------------------------------------------

describe('exclusionHexes', () => {
  it('is empty until a site has been placed', () => {
    expect(exclusionHexes(map, PLAYER, [])).toEqual([]);
  });

  it('covers everything nearer than the exclusion radius, and nothing further', () => {
    const sites = walk(2);
    const excluded = keysOf(exclusionHexes(map, PLAYER, sites));
    const zone = RULES.homeZoneRows[PLAYER];

    for (const tile of map.tiles) {
      if (tile.row < zone.min || tile.row > zone.max) continue;
      const hex = offsetToAxial({ col: tile.col, row: tile.row });
      const near = sites.some(
        (s) => distance(s.hex, hex) < RULES.bunkerExclusionRadius,
      );
      expect(excluded.has(hexKey(hex))).toBe(near);
    }
  });

  it('is exactly the home-zone ground missing from the base highlight', () => {
    // The overlay's whole job: explain why those hexes are not offered. If the
    // two ever disagreed, the player would see a hex greyed out for no visible
    // reason, or an unexplained hole in the highlight.
    const sites = walk(2);
    const zone = RULES.homeZoneRows[PLAYER];

    const offered = keysOf(placementTargets(map, PLAYER, sites));
    const excluded = keysOf(exclusionHexes(map, PLAYER, sites));
    const taken = keysOf(sites.map((s) => s.hex));
    const spawns = keysOf(ALL_SPAWN_HEXES.map(offsetToAxial));

    for (const tile of map.tiles) {
      if (tile.row < zone.min || tile.row > zone.max) continue;
      const key = hexKey(offsetToAxial({ col: tile.col, row: tile.row }));
      if (offered.has(key) || taken.has(key) || spawns.has(key)) continue;
      expect(excluded.has(key)).toBe(true);
    }
  });

  it('stays inside the placing player’s own home zone and on the board', () => {
    const sites = walk(2);
    const zone = RULES.homeZoneRows[PLAYER];

    for (const hex of exclusionHexes(map, PLAYER, sites)) {
      const { col, row } = axialToOffset(hex);
      expect(row).toBeGreaterThanOrEqual(zone.min);
      expect(row).toBeLessThanOrEqual(zone.max);
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(map.width);
    }
  });

  /**
   * §12 again: the rule is identical for both sites, so the overlay must not
   * distinguish them. A flat de-duplicated list is what guarantees the UI has no
   * way to draw the bunker's ring differently from the decoy's — the asymmetry
   * is unrepresentable rather than merely avoided.
   */
  it('reports no hex twice, even where the two rings overlap', () => {
    const sites = walk(2);
    const hexes = exclusionHexes(map, PLAYER, sites);
    expect(new Set(hexes.map(hexKey)).size).toBe(hexes.length);
  });
});
