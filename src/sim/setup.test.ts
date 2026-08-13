import { describe, expect, it } from 'vitest';
import { ALL_SPAWN_HEXES, RULES, SPAWNS, UNIT_DEFS } from './defs';
import {
  axialToOffset,
  distance,
  hexKey,
  offsetToAxial,
  type Hex,
} from './hex';
import { generateMap, tileAt, type MapData, type TileData } from './map';
import {
  PLACEMENT_ORDER,
  legalPlacementHexes,
  nextPlacementKind,
  startMatch,
  validatePlacement,
  validateSetup,
  type Placement,
  type PlayerSetup,
} from './setup';
import type { PlayerId } from './types';

// --- fixtures ---------------------------------------------------------------
//
// A synthetic all-plains board at the REAL dimensions (spec §7), because the
// home zones and the 8 spawn hexes are absolute row/col coordinates — a
// convenient 21x21 test board would put P1's zone off the map. Terrain is
// controlled rather than generated, so a mountain in a test is one the test put
// there. The fill order matches generateMap's column-major order, which tileAt's
// index math depends on.

function makeMap(width = 16, height = 19): MapData {
  const tiles: TileData[] = [];
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < height; row++) {
      tiles.push({ col, row, terrain: 'plains' });
    }
  }
  return { width, height, tiles };
}

function at(col: number, row: number): Hex {
  return offsetToAxial({ col, row });
}

function place(kind: Placement['kind'], hex: Hex): Placement {
  return { kind, hex };
}

/**
 * A legal P1 setup, hand-picked rather than derived, so the rule tests below are
 * not checking the validator against itself. Column 5 is clear of every spawn,
 * and same-column hexes are exactly |Δrow| apart — asserted, not assumed.
 */
const BUNKER = at(5, 13);
const DECOY = at(5, 18);
const BASE_A = at(0, 16);
const BASE_B = at(11, 16);

const SITES: PlayerSetup = [place('bunker', BUNKER), place('decoy', DECOY)];

const LEGAL_SETUP: PlayerSetup = [
  ...SITES,
  place('interceptor', BASE_A),
  place('interceptor', BASE_B),
];

/** Every hex in a player's home zone, in the map's own column-major order. */
function homeZoneHexes(player: PlayerId, width = 16): Hex[] {
  const zone = RULES.homeZoneRows[player];
  const hexes: Hex[] = [];
  for (let col = 0; col < width; col++) {
    for (let row = zone.min; row <= zone.max; row++) hexes.push(at(col, row));
  }
  return hexes;
}

/** Walk the placement order to a legal complete setup, using the UI's own list. */
function derivedSetup(map: MapData, player: PlayerId): Placement[] {
  const setup: Placement[] = [];
  for (const kind of PLACEMENT_ORDER) {
    for (let n = 0; n < RULES.placementCounts[kind]; n++) {
      const [hex] = legalPlacementHexes(map, player, kind, setup);
      expect(hex).toBeDefined();
      setup.push(place(kind, hex));
    }
  }
  return setup;
}

// --- the roster and the order (spec §12) ------------------------------------

describe('validatePlacement() — roster and order', () => {
  it('accepts the first bunker anywhere legal in the home zone', () => {
    expect(validatePlacement(makeMap(), 'p1', 'bunker', BUNKER, [])).toEqual({
      legal: true,
    });
  });

  it('rejects a second bunker', () => {
    expect(
      validatePlacement(makeMap(), 'p1', 'bunker', at(6, 13), [
        place('bunker', BUNKER),
      ]),
    ).toEqual({ legal: false, reason: 'ALREADY_PLACED' });
  });

  it('rejects a third interceptor base', () => {
    expect(
      validatePlacement(makeMap(), 'p1', 'interceptor', at(8, 13), LEGAL_SETUP),
    ).toEqual({ legal: false, reason: 'ALREADY_PLACED' });
  });

  /**
   * There is no placement order (changed 2026-08-13). Each of the four assets
   * may be the first one down — the old OUT_OF_ORDER rejection existed only
   * because the ≥3 exclusion rule was checked from the base's side alone, and it
   * is now checked symmetrically instead.
   */
  it('accepts any of the four kinds as the first placement', () => {
    const map = makeMap();

    expect(validatePlacement(map, 'p1', 'bunker', BUNKER, [])).toEqual({
      legal: true,
    });
    expect(validatePlacement(map, 'p1', 'decoy', DECOY, [])).toEqual({
      legal: true,
    });
    expect(validatePlacement(map, 'p1', 'interceptor', BASE_A, [])).toEqual({
      legal: true,
    });
  });

  it('accepts a base with only one site down, and with none', () => {
    const map = makeMap();

    expect(
      validatePlacement(map, 'p1', 'interceptor', BASE_A, [
        place('bunker', BUNKER),
      ]),
    ).toEqual({ legal: true });
    expect(
      validatePlacement(map, 'p1', 'interceptor', BASE_A, [
        place('decoy', DECOY),
      ]),
    ).toEqual({ legal: true });
  });

  it('accepts a setup submitted in reverse roster order', () => {
    const reversed = [...LEGAL_SETUP].reverse();
    expect(validateSetup(makeMap(), 'p1', reversed)).toEqual({ legal: true });
  });

  it('covers exactly the placeable kinds', () => {
    expect([...PLACEMENT_ORDER].sort()).toEqual(
      Object.keys(RULES.placementCounts).sort(),
    );
  });
});

// --- where a site may stand (spec §7, §12) ----------------------------------

describe('validatePlacement() — geometry', () => {
  it('rejects a hex off the map', () => {
    expect(
      validatePlacement(makeMap(), 'p1', 'bunker', at(99, 16), []),
    ).toEqual({ legal: false, reason: 'OFF_MAP' });
  });

  it('rejects the neutral ground between the home zones', () => {
    const justOutside = RULES.homeZoneRows.p1.min - 1;

    expect(
      validatePlacement(makeMap(), 'p1', 'bunker', at(5, justOutside), []),
    ).toEqual({ legal: false, reason: 'OUTSIDE_HOME_ZONE' });
  });

  it('rejects a hex in the ENEMY home zone', () => {
    expect(
      validatePlacement(makeMap(), 'p1', 'bunker', at(5, RULES.homeZoneRows.p2.min), []),
    ).toEqual({ legal: false, reason: 'OUTSIDE_HOME_ZONE' });
  });

  it('rejects every spawn hex', () => {
    for (const spawn of SPAWNS.p1.launchers) {
      expect(
        validatePlacement(makeMap(), 'p1', 'bunker', offsetToAxial(spawn), []),
      ).toEqual({ legal: false, reason: 'SPAWN_HEX' });
    }

    expect(
      validatePlacement(makeMap(), 'p1', 'bunker', offsetToAxial(SPAWNS.p1.drone), []),
    ).toEqual({ legal: false, reason: 'SPAWN_HEX' });
  });

  it('rejects a hex one of your own assets already holds', () => {
    expect(
      validatePlacement(makeMap(), 'p1', 'decoy', BUNKER, [place('bunker', BUNKER)]),
    ).toEqual({ legal: false, reason: 'HEX_TAKEN' });
  });

  it('allows all three kinds on a mountain (§12: built, not driven)', () => {
    const map = makeMap();
    const peak = BUNKER;
    const tile = tileAt(map, { col: 5, row: 13 });
    expect(tile).toBeDefined();
    tile!.terrain = 'mountain';

    // The bunker and the decoy must agree exactly, or the terrain a site stands
    // on would identify the real one for free.
    expect(validatePlacement(map, 'p1', 'bunker', peak, [])).toEqual({ legal: true });
    expect(
      validatePlacement(map, 'p1', 'decoy', peak, [place('bunker', at(6, 13))]),
    ).toEqual({ legal: true });
  });
});

// --- the ≥3 exclusion, identical for both sites (spec §12) ------------------

describe('validatePlacement() — the interceptor exclusion', () => {
  it('rejects a base too close to the bunker', () => {
    const close = at(5, 13 + (RULES.bunkerExclusionRadius - 1));
    expect(distance(BUNKER, close)).toBe(RULES.bunkerExclusionRadius - 1);

    expect(
      validatePlacement(makeMap(), 'p1', 'interceptor', close, SITES),
    ).toEqual({ legal: false, reason: 'EXCLUSION_ZONE' });
  });

  it('rejects a base too close to the DECOY, at a legal distance from the bunker', () => {
    const close = at(5, 18 - (RULES.bunkerExclusionRadius - 1));
    expect(distance(DECOY, close)).toBe(RULES.bunkerExclusionRadius - 1);
    expect(distance(BUNKER, close)).toBeGreaterThanOrEqual(
      RULES.bunkerExclusionRadius,
    );

    expect(
      validatePlacement(makeMap(), 'p1', 'interceptor', close, SITES),
    ).toEqual({ legal: false, reason: 'EXCLUSION_ZONE' });
  });

  /**
   * The other half of the same rule (added 2026-08-13). The constraint is on a
   * *pair*, so it has to be enforced from whichever side arrives second —
   * otherwise placing the base first would let a player put a site right on top
   * of it, which is the point-blank shield §12 exists to forbid.
   *
   * Both sites are tested, because a rule that caught only the bunker would make
   * "the site you are allowed to build beside your base" provably the decoy.
   */
  it('rejects a SITE placed too close to an existing base — both kinds', () => {
    const map = makeMap();
    const bases: PlayerSetup = [place('interceptor', BASE_A)];
    const close = at(0, 16 - (RULES.bunkerExclusionRadius - 1));
    expect(distance(BASE_A, close)).toBe(RULES.bunkerExclusionRadius - 1);

    expect(validatePlacement(map, 'p1', 'bunker', close, bases)).toEqual({
      legal: false,
      reason: 'EXCLUSION_ZONE',
    });
    expect(validatePlacement(map, 'p1', 'decoy', close, bases)).toEqual({
      legal: false,
      reason: 'EXCLUSION_ZONE',
    });
  });

  it('gives the same verdict whichever order the pair is submitted in', () => {
    // The property that makes free placement safe: an illegal board is illegal
    // no matter how it was assembled. Without the symmetric check, the
    // base-first sequence passes and an unplayable setup reaches startMatch.
    const map = makeMap();
    const close = at(0, 16 - (RULES.bunkerExclusionRadius - 1));

    const siteFirst: PlayerSetup = [
      place('bunker', close),
      place('interceptor', BASE_A),
    ];
    const baseFirst: PlayerSetup = [
      place('interceptor', BASE_A),
      place('bunker', close),
    ];

    expect(validateSetup(map, 'p1', siteFirst)).toMatchObject({
      legal: false,
      reason: 'EXCLUSION_ZONE',
    });
    expect(validateSetup(map, 'p1', baseFirst)).toMatchObject({
      legal: false,
      reason: 'EXCLUSION_ZONE',
    });
  });

  it('accepts a base at exactly the exclusion radius — the bound is inclusive', () => {
    // Searched rather than hand-picked: with two sites on the board the hexes at
    // exactly 3 from one and no closer to the other are a thin ring, and a
    // hardcoded guess would be testing the fixture rather than the rule.
    const edge = homeZoneHexes('p1').find(
      (hex) =>
        distance(BUNKER, hex) === RULES.bunkerExclusionRadius &&
        distance(DECOY, hex) >= RULES.bunkerExclusionRadius,
    );
    expect(edge).toBeDefined();

    expect(validatePlacement(makeMap(), 'p1', 'interceptor', edge!, SITES)).toEqual({
      legal: true,
    });
  });

  it('measures the exclusion from the site, not from the other base', () => {
    // Two bases may sit next to each other — the rule names the sites only.
    const neighbourOfBase = at(0, 15);
    expect(distance(BASE_A, neighbourOfBase)).toBe(1);

    expect(
      validatePlacement(makeMap(), 'p1', 'interceptor', neighbourOfBase, [
        ...SITES,
        place('interceptor', BASE_A),
      ]),
    ).toEqual({ legal: true });
  });
});

// --- the UI's highlight list ------------------------------------------------

describe('legalPlacementHexes()', () => {
  it('offers the whole home zone except the spawns', () => {
    const map = makeMap();
    const hexes = legalPlacementHexes(map, 'p1', 'bunker', []);
    const spawns = new Set(ALL_SPAWN_HEXES.map((o) => hexKey(offsetToAxial(o))));
    const zone = RULES.homeZoneRows.p1;
    const zoneSize = map.width * (zone.max - zone.min + 1);
    const ownSpawns = SPAWNS.p1.launchers.length + 1;

    for (const hex of hexes) {
      const { row } = axialToOffset(hex);
      expect(row).toBeGreaterThanOrEqual(zone.min);
      expect(row).toBeLessThanOrEqual(zone.max);
      expect(spawns.has(hexKey(hex))).toBe(false);
    }

    // Only this player's own 4 spawns fall inside their zone, so the count is
    // exact — which also pins that nothing else is quietly being filtered out.
    expect(hexes).toHaveLength(zoneSize - ownSpawns);
  });

  it('drops the exclusion zone once both sites are placed', () => {
    const map = makeMap();
    const before = legalPlacementHexes(map, 'p1', 'interceptor', SITES);
    const tooClose = at(5, 14);

    expect(distance(BUNKER, tooClose)).toBeLessThan(RULES.bunkerExclusionRadius);
    expect(before.some((h) => hexKey(h) === hexKey(tooClose))).toBe(false);
    expect(before.some((h) => hexKey(h) === hexKey(BASE_A))).toBe(true);
  });

  it('offers ground for any kind at any time — there is no placement order', () => {
    // With nothing placed, all three kinds are offered the same ground: no
    // exclusion applies yet, and §12 gives bunker, decoy and base identical
    // terrain and zone rules.
    const map = makeMap();
    const bunker = legalPlacementHexes(map, 'p1', 'bunker', []).map(hexKey);
    const decoy = legalPlacementHexes(map, 'p1', 'decoy', []).map(hexKey);
    const base = legalPlacementHexes(map, 'p1', 'interceptor', []).map(hexKey);

    expect(bunker.length).toBeGreaterThan(0);
    expect(decoy).toEqual(bunker);
    expect(base).toEqual(bunker);
  });

  it('offers nothing once that kind’s roster slots are full', () => {
    expect(
      legalPlacementHexes(makeMap(), 'p1', 'interceptor', LEGAL_SETUP),
    ).toEqual([]);
  });

  /**
   * The mirror of the base exclusion, seen through the highlight: with a base
   * already down, the ground offered for a site has a hole in it. Both site
   * kinds get exactly the same hole, or terrain itself would identify the real
   * bunker (§12).
   */
  it('withholds the same ground from bunker and decoy near a placed base', () => {
    const map = makeMap();
    const bases: PlayerSetup = [place('interceptor', BASE_A)];

    const bunker = legalPlacementHexes(map, 'p1', 'bunker', bases).map(hexKey);
    const decoy = legalPlacementHexes(map, 'p1', 'decoy', bases).map(hexKey);
    const open = legalPlacementHexes(map, 'p1', 'bunker', []).map(hexKey);

    expect(bunker).toEqual(decoy);
    expect(bunker.length).toBeLessThan(open.length);
  });

  it('gives the two players disjoint ground — so neither can ever see the other', () => {
    // The reason placement validation never consults the enemy's setup: it
    // cannot collide with it. If the zones overlapped, the highlight list would
    // have to account for enemy assets and would become a detector (§11).
    const map = makeMap();
    const p1 = new Set(legalPlacementHexes(map, 'p1', 'bunker', []).map(hexKey));
    const p2 = legalPlacementHexes(map, 'p2', 'bunker', []).map(hexKey);

    expect(p2.some((key) => p1.has(key))).toBe(false);
  });
});

// --- whole setups -----------------------------------------------------------

describe('validateSetup()', () => {
  it('accepts a complete legal setup', () => {
    expect(validateSetup(makeMap(), 'p1', LEGAL_SETUP)).toEqual({ legal: true });
  });

  it('names the placement that failed', () => {
    const broken = [
      ...SITES,
      place('interceptor', at(5, 14)), // 1 hex from the bunker
      place('interceptor', BASE_B),
    ];

    expect(validateSetup(makeMap(), 'p1', broken)).toEqual({
      legal: false,
      index: 2,
      reason: 'EXCLUSION_ZONE',
    });
  });

  it('rejects a short roster as incomplete, pointing at the missing slot', () => {
    expect(validateSetup(makeMap(), 'p1', SITES)).toEqual({
      legal: false,
      index: 2,
      reason: 'INCOMPLETE',
    });
  });

  it('rejects an over-long roster on the placement that overflowed', () => {
    const tooMany = [...LEGAL_SETUP, place('interceptor', at(8, 13))];

    expect(validateSetup(makeMap(), 'p1', tooMany)).toEqual({
      legal: false,
      index: 4,
      reason: 'ALREADY_PLACED',
    });
  });

  it('holds P2 to the same rules in their own zone', () => {
    const mirrored: PlayerSetup = [
      place('bunker', at(5, 5)),
      place('decoy', at(5, 0)),
      place('interceptor', at(0, 2)),
      place('interceptor', at(11, 2)),
    ];

    expect(validateSetup(makeMap(), 'p2', mirrored)).toEqual({ legal: true });
    expect(validateSetup(makeMap(), 'p1', mirrored)).toEqual({
      legal: false,
      index: 0,
      reason: 'OUTSIDE_HOME_ZONE',
    });
  });
});

// --- the opening board (spec §5's SETUP -> ORDER_PHASE edge) -----------------

describe('startMatch()', () => {
  const map = makeMap();
  const setups: Record<PlayerId, PlayerSetup> = {
    p1: LEGAL_SETUP,
    p2: [
      place('bunker', at(5, 5)),
      place('decoy', at(5, 0)),
      place('interceptor', at(0, 2)),
      place('interceptor', at(11, 2)),
    ],
  };

  it('fields 8 assets per player, and nothing else (§2)', () => {
    const state = startMatch(map, setups);

    expect(state.units).toHaveLength(16);
    for (const player of ['p1', 'p2'] as const) {
      const mine = state.units.filter((u) => u.owner === player);
      const kinds = mine.map((u) => u.kind);
      expect(kinds.filter((k) => k === 'launcher')).toHaveLength(3);
      expect(kinds.filter((k) => k === 'drone')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'bunker')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'decoy')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'interceptor')).toHaveLength(2);
    }
  });

  it('starts launchers and the drone on their public spawn hexes (§7)', () => {
    const state = startMatch(map, setups);
    const positions = (kind: string, player: PlayerId) =>
      state.units
        .filter((u) => u.owner === player && u.kind === kind)
        .map((u) => hexKey(u.position))
        .sort();

    expect(positions('launcher', 'p1')).toEqual(
      SPAWNS.p1.launchers.map((o) => hexKey(offsetToAxial(o))).sort(),
    );
    expect(positions('drone', 'p2')).toEqual([
      hexKey(offsetToAxial(SPAWNS.p2.drone)),
    ]);
  });

  it('puts placed assets on the hexes they were placed on, at full health', () => {
    const state = startMatch(map, setups);
    const bunker = state.units.find((u) => u.owner === 'p1' && u.kind === 'bunker');
    const decoy = state.units.find((u) => u.owner === 'p1' && u.kind === 'decoy');

    expect(bunker?.position).toEqual(BUNKER);
    expect(bunker?.hp).toBe(UNIT_DEFS.bunker.hp);
    expect(decoy?.position).toEqual(DECOY);
    expect(decoy?.hp).toBe(UNIT_DEFS.decoy.hp);
    expect(state.units.every((u) => !u.destroyed)).toBe(true);
  });

  it('gives every unit a unique id', () => {
    const state = startMatch(map, setups);
    const ids = new Set(state.units.map((u) => u.id));

    expect(ids.size).toBe(state.units.length);
  });

  it('opens on round 1 of the order phase with nothing known and nothing decided', () => {
    const state = startMatch(map, setups);

    expect(state.round).toBe(1);
    expect(state.phase).toBe('ORDER_PHASE');
    expect(state.outcome).toBeNull();
    expect(state.deadHandFor).toBeNull();
    expect(state.droneRespawnIn).toEqual({ p1: 0, p2: 0 });
    expect(state.intel).toEqual({
      p1: { staticReveals: [], contacts: [] },
      p2: { staticReveals: [], contacts: [] },
    });
  });

  it('throws rather than start a match on an illegal setup', () => {
    const illegal: Record<PlayerId, PlayerSetup> = {
      ...setups,
      p2: [place('bunker', at(5, 5)), place('decoy', at(5, 0))],
    };

    expect(() => startMatch(map, illegal)).toThrow(/p2/);
  });

  it('works on a real generated board, mountains and all', () => {
    const real = generateMap();
    const state = startMatch(real, {
      p1: derivedSetup(real, 'p1'),
      p2: derivedSetup(real, 'p2'),
    });

    expect(state.units).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// nextPlacementKind (build-order step 10b)
// ---------------------------------------------------------------------------

describe('nextPlacementKind', () => {
  const map = makeMap();

  // Four widely-spaced hexes in P1's home zone, clear of every spawn row and far
  // enough apart that the ≥3 exclusion rule never fires — this describe is about
  // the *order* of placement, so nothing else should be able to reject a hex.
  const SPOTS = [at(0, 14), at(4, 14), at(9, 14), at(14, 14)];

  it('walks the roster in PLACEMENT_ORDER and then reports done', () => {
    const steps: (Placement['kind'] | null)[] = [];
    const placed: Placement[] = [];

    // Four placements, so five answers: one before each and one after the last.
    for (let i = 0; i <= SPOTS.length; i++) {
      const kind = nextPlacementKind(placed);
      steps.push(kind);
      if (kind) placed.push(place(kind, SPOTS[i]));
    }

    expect(steps).toEqual(['bunker', 'decoy', 'interceptor', 'interceptor', null]);
  });

  it('only ever suggests a kind validatePlacement would accept', () => {
    // It is a suggestion, not a rule — other kinds are legal too — but the one
    // it names must never be refused, or the setup UI's pre-selection would
    // highlight ground for an asset the validator then rejects.
    const placed: Placement[] = [];

    for (const spot of SPOTS) {
      const kind = nextPlacementKind(placed);
      expect(kind).not.toBeNull();
      expect(validatePlacement(map, 'p1', kind!, spot, placed)).toEqual({
        legal: true,
      });
      placed.push(place(kind!, spot));
    }

    expect(nextPlacementKind(placed)).toBeNull();
  });

  it('does not stop the other kinds being placed first', () => {
    // The old behaviour: everything but `nextPlacementKind`'s answer was
    // OUT_OF_ORDER. Now a suggestion is all it is.
    expect(nextPlacementKind([])).toBe('bunker');
    expect(validatePlacement(map, 'p1', 'interceptor', SPOTS[0], [])).toEqual({
      legal: true,
    });
  });

  it('reports what is still owed, even for a setup assembled out of order', () => {
    // Not something the UI can produce — but a saved game or a V1.5 client
    // message could, and "the first unfilled slot" is the answer that keeps
    // validatePlacement's OUT_OF_ORDER rule satisfiable from there.
    expect(nextPlacementKind([place('decoy', SPOTS[1])])).toBe('bunker');
  });

  it('reaches every kind in RULES.placementCounts, the right number of times', () => {
    // A placeable asset missing from PLACEMENT_ORDER would never be reached, and
    // a setup could then never complete. Walking to exhaustion is what catches it.
    const placed: Placement[] = [];
    let kind = nextPlacementKind(placed);

    while (kind) {
      placed.push(place(kind, SPOTS[placed.length]));
      kind = nextPlacementKind(placed);
    }

    for (const [k, count] of Object.entries(RULES.placementCounts)) {
      expect(placed.filter((p) => p.kind === k)).toHaveLength(count);
    }
  });
});

// ---------------------------------------------------------------------------
// Canonical unit order (2026-08-13, when placement order became free)
// ---------------------------------------------------------------------------

describe('startMatch() — unit order is a function of the setup, not of the clicks', () => {
  /**
   * §9 emits unit-naming events in `GameState.units` order, so that order has to
   * be canonical. Once the setup UI let a player place their four assets in any
   * sequence, "canonical" stopped being free: two players who built the SAME
   * board in different orders would otherwise produce differently-ordered logs
   * from an identical position. `startingUnits` sorts by PLACEMENT_ORDER to fix
   * it, and this is the test that would fail if that sort were removed.
   */
  it('produces identical units for the same board placed in a different order', () => {
    const map = makeMap();
    const forward: Record<PlayerId, PlayerSetup> = {
      p1: LEGAL_SETUP,
      p2: [
        place('bunker', at(5, 5)),
        place('decoy', at(5, 0)),
        place('interceptor', at(0, 2)),
        place('interceptor', at(11, 2)),
      ],
    };
    const shuffled: Record<PlayerId, PlayerSetup> = {
      // Bases first, then the decoy, then the bunker — legal now, and the exact
      // sequence the old OUT_OF_ORDER rule existed to forbid.
      p1: [
        place('interceptor', BASE_A),
        place('interceptor', BASE_B),
        place('decoy', DECOY),
        place('bunker', BUNKER),
      ],
      p2: forward.p2,
    };

    expect(startMatch(map, shuffled).units).toEqual(
      startMatch(map, forward).units,
    );
  });

  it('still numbers the two bases in the order the player placed them', () => {
    // The one ordering the player keeps: which base is 1 and which is 2.
    const map = makeMap();
    const swapped: PlayerSetup = [
      ...SITES,
      place('interceptor', BASE_B),
      place('interceptor', BASE_A),
    ];
    const units = startMatch(map, {
      p1: swapped,
      p2: [
        place('bunker', at(5, 5)),
        place('decoy', at(5, 0)),
        place('interceptor', at(0, 2)),
        place('interceptor', at(11, 2)),
      ],
    }).units;

    const base1 = units.find((u) => u.id === 'p1-interceptor-1');
    expect(base1?.position).toEqual(BASE_B);
  });
});
