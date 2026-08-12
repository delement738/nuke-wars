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

  it('rejects the decoy before the bunker', () => {
    expect(validatePlacement(makeMap(), 'p1', 'decoy', DECOY, [])).toEqual({
      legal: false,
      reason: 'OUT_OF_ORDER',
    });
  });

  it('rejects a base before both sites are down — the exclusion rule needs them', () => {
    expect(
      validatePlacement(makeMap(), 'p1', 'interceptor', BASE_A, [
        place('bunker', BUNKER),
      ]),
    ).toEqual({ legal: false, reason: 'OUT_OF_ORDER' });
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
    ).toEqual({ legal: false, reason: 'TOO_CLOSE_TO_SITE' });
  });

  it('rejects a base too close to the DECOY, at a legal distance from the bunker', () => {
    const close = at(5, 18 - (RULES.bunkerExclusionRadius - 1));
    expect(distance(DECOY, close)).toBe(RULES.bunkerExclusionRadius - 1);
    expect(distance(BUNKER, close)).toBeGreaterThanOrEqual(
      RULES.bunkerExclusionRadius,
    );

    expect(
      validatePlacement(makeMap(), 'p1', 'interceptor', close, SITES),
    ).toEqual({ legal: false, reason: 'TOO_CLOSE_TO_SITE' });
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

  it('offers nothing when it is not this kind’s turn', () => {
    expect(legalPlacementHexes(makeMap(), 'p1', 'interceptor', [])).toEqual([]);
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
      reason: 'TOO_CLOSE_TO_SITE',
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
