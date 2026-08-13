import { describe, expect, it } from 'vitest';
import { ALL_SPAWN_HEXES, RULES } from '../sim/defs';
import { axialToOffset, distance, hexKey, offsetToAxial, type Hex } from '../sim/hex';
import { generateMap, type MapData } from '../sim/map';
import { validateSetup } from '../sim/setup';
import { PLAYERS, type PlayerId } from '../sim/types';
import {
  ROSTER_SIZE,
  emptyPlacementDraft,
  exclusionHexes,
  firstEmptySlot,
  placementComplete,
  placementSetup,
  placementSlots,
  placementTargets,
  withPlacementInSlot,
  withoutSlot,
  type PlacementDraft,
} from './placement';

const map: MapData = generateMap(undefined, undefined, 42);
const PLAYER: PlayerId = 'p1';

/** Slot ids, by name, so the tests read as intent rather than as indexes. */
const BUNKER = 0;
const DECOY = 1;
const BASE_1 = 2;
const BASE_2 = 3;

function keysOf(hexes: readonly Hex[]): Set<string> {
  return new Set(hexes.map(hexKey));
}

/** Fill `slotId` with the first hex the module offers for it. */
function fill(draft: PlacementDraft, slotId: number, pick = 0): PlacementDraft {
  const targets = placementTargets(map, PLAYER, draft, slotId);
  expect(targets.length).toBeGreaterThan(pick);
  return withPlacementInSlot(map, PLAYER, draft, slotId, targets[pick]);
}

/** A draft with the named slots filled, in the order given. */
function fillAll(order: number[] = [BUNKER, DECOY, BASE_1, BASE_2]): PlacementDraft {
  return order.reduce<PlacementDraft>(
    (draft, slotId) => fill(draft, slotId),
    emptyPlacementDraft(),
  );
}

/** The placements in a draft, empty slots dropped — what the sim would receive. */
function setupOf(draft: PlacementDraft) {
  return placementSetup(draft);
}

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

describe('placementSlots', () => {
  it('is always the full roster, empty or not', () => {
    for (const placed of [[], fillAll()]) {
      const slots = placementSlots(placed);
      expect(slots).toHaveLength(ROSTER_SIZE);
      expect(slots.map((s) => s.kind)).toEqual([
        'bunker',
        'decoy',
        'interceptor',
        'interceptor',
      ]);
      expect(slots.map((s) => s.id)).toEqual([0, 1, 2, 3]);
    }
  });

  it('numbers only the kinds with more than one slot', () => {
    const slots = placementSlots([]);
    expect(slots.map((s) => `${s.index}/${s.ofKind}`)).toEqual([
      '1/1',
      '1/1',
      '1/2',
      '2/2',
    ]);
  });

  it('reports empty slots as empty and filled ones with their hex', () => {
    const placed = fill([], DECOY);
    const slots = placementSlots(placed);

    expect(slots[BUNKER].hex).toBeNull();
    expect(slots[DECOY].hex).toEqual(setupOf(placed)[0].hex);
    // Every other slot stays empty: a placement lands in the slot the player
    // picked, never in the first free one of its kind.
    expect(slots.filter((s) => s.hex !== null)).toHaveLength(1);
  });

  /**
   * The reason the draft is slot-addressed rather than a growing list: a player
   * who picks "Interceptor base 2" out of the roster and clicks expects the
   * asset to appear on THAT row. A list keyed only by kind would put the first
   * base placed into base 1's slot whichever button was pressed, and the panel
   * would silently contradict the click that filled it.
   */
  it('fills the slot that was chosen, not the first free one of that kind', () => {
    const slots = placementSlots(fillAll([BASE_2]));

    expect(slots[BASE_1].hex).toBeNull();
    expect(slots[BASE_2].hex).not.toBeNull();
  });
});

describe('firstEmptySlot / placementComplete', () => {
  it('walks forward as slots fill, then reports done', () => {
    let placed: PlacementDraft = emptyPlacementDraft();
    const seen: (number | null)[] = [];

    for (let i = 0; i <= ROSTER_SIZE; i++) {
      seen.push(firstEmptySlot(placed));
      if (i < ROSTER_SIZE) placed = fill(placed, firstEmptySlot(placed)!);
    }

    expect(seen).toEqual([0, 1, 2, 3, null]);
    expect(placementComplete(placed)).toBe(true);
  });

  it('reports the earliest gap, not the next index', () => {
    // Placement order is free, so "first empty" has to mean first, not next.
    const placed = fillAll([BASE_1, BASE_2, DECOY]);
    expect(firstEmptySlot(placed)).toBe(BUNKER);
    expect(placementComplete(placed)).toBe(false);
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
  it('offers only the placing player’s own home zone', () => {
    for (const player of PLAYERS) {
      const zone = RULES.homeZoneRows[player];
      for (const hex of placementTargets(map, player, [], BUNKER)) {
        const { row } = axialToOffset(hex);
        expect(row).toBeGreaterThanOrEqual(zone.min);
        expect(row).toBeLessThanOrEqual(zone.max);
      }
    }
  });

  it('never offers a spawn hex (spec §12)', () => {
    const spawns = keysOf(ALL_SPAWN_HEXES.map(offsetToAxial));
    for (const player of PLAYERS) {
      for (const hex of placementTargets(map, player, [], BUNKER)) {
        expect(spawns.has(hexKey(hex))).toBe(false);
      }
    }
  });

  /**
   * There is no placement order (§12, changed 2026-08-13), so every slot is
   * offered ground from the very first click — including the bases, which used
   * to be locked until both sites were down.
   */
  it('offers ground for every slot on an empty setup', () => {
    for (const slotId of [BUNKER, DECOY, BASE_1, BASE_2]) {
      expect(placementTargets(map, PLAYER, [], slotId).length).toBeGreaterThan(0);
    }
  });

  /**
   * §12's indistinguishability principle, on the one screen where a player could
   * see it break: the ground offered for the decoy must be the ground offered
   * for the bunker. If the two ever differed, every site found on the difference
   * would be provably real.
   */
  it('offers the bunker and the decoy identical ground, in both directions', () => {
    expect(keysOf(placementTargets(map, PLAYER, [], BUNKER))).toEqual(
      keysOf(placementTargets(map, PLAYER, [], DECOY)),
    );

    // And with a base down, so the exclusion rule is in play for both.
    const withBase = fill([], BASE_1);
    expect(keysOf(placementTargets(map, PLAYER, withBase, BUNKER))).toEqual(
      keysOf(placementTargets(map, PLAYER, withBase, DECOY)),
    );
  });

  it('withholds ground inside the exclusion radius of a placed site', () => {
    const sites = fillAll([BUNKER, DECOY]);
    const targets = placementTargets(map, PLAYER, sites, BASE_1);

    for (const hex of targets) {
      for (const site of setupOf(sites)) {
        expect(distance(site.hex, hex)).toBeGreaterThanOrEqual(
          RULES.bunkerExclusionRadius,
        );
      }
    }
    expect(targets.length).toBeLessThan(
      placementTargets(map, PLAYER, [], BASE_1).length,
    );
  });

  /**
   * The mirror of the rule above, and the half that only exists because
   * placement order became free: with a base already down, the ground offered
   * for a SITE has the same hole in it.
   */
  it('withholds ground inside the exclusion radius of a placed base', () => {
    const bases = fillAll([BASE_1]);
    const targets = placementTargets(map, PLAYER, bases, BUNKER);

    for (const hex of targets) {
      expect(distance(setupOf(bases)[0].hex, hex)).toBeGreaterThanOrEqual(
        RULES.bunkerExclusionRadius,
      );
    }
    expect(targets.length).toBeLessThan(
      placementTargets(map, PLAYER, [], BUNKER).length,
    );
  });

  /**
   * A slot already on the board is offered somewhere to MOVE to, and its own
   * exclusion ring must not be part of what blocks it — otherwise nudging a base
   * one hex would be refused by the position it is leaving.
   */
  it('does not let a placed asset block its own relocation', () => {
    const full = fillAll();
    const baseHex = placementSlots(full)[BASE_1].hex!;
    const targets = placementTargets(map, PLAYER, full, BASE_1);

    expect(targets.length).toBeGreaterThan(0);
    // Its own hex is offered back — putting it where it already is is legal.
    expect(keysOf(targets).has(hexKey(baseHex))).toBe(true);
    // And the other three assets still block their own hexes.
    for (const slot of placementSlots(full)) {
      if (slot.id === BASE_1) continue;
      expect(keysOf(targets).has(hexKey(slot.hex!))).toBe(false);
    }
  });

  it('is empty for a slot id that does not exist', () => {
    expect(placementTargets(map, PLAYER, [], ROSTER_SIZE)).toEqual([]);
  });

  /**
   * Mountains are legal for all three placed kinds (spec §2, §12, gotcha 7b).
   * `groundPassable` is emphatically NOT the placement test — reading it here
   * would silently forbid mountain sites, and because that would apply to bunker
   * and decoy alike it would not even show up as an asymmetry. It would just
   * quietly delete a real strategic option.
   */
  it('offers mountain hexes, not just plains', () => {
    const mountains = new Set(
      map.tiles
        .filter((t) => t.terrain === 'mountain')
        .map((t) => hexKey(offsetToAxial({ col: t.col, row: t.row }))),
    );
    const offered = placementTargets(map, PLAYER, [], BUNKER);

    expect(offered.some((hex) => mountains.has(hexKey(hex)))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Editing the setup
// ---------------------------------------------------------------------------

describe('withPlacementInSlot', () => {
  it('places into the slot that was asked for, whichever it is', () => {
    const placed = fill(emptyPlacementDraft(), BASE_2);
    const slots = placementSlots(placed);

    expect(setupOf(placed)).toHaveLength(1);
    expect(slots[BASE_2].kind).toBe('interceptor');
    expect(slots[BASE_2].hex).not.toBeNull();
    expect(slots[BASE_1].hex).toBeNull();
  });

  it('accepts the four assets in any order', () => {
    for (const order of [
      [BUNKER, DECOY, BASE_1, BASE_2],
      [BASE_1, BASE_2, BUNKER, DECOY],
      [DECOY, BASE_1, BUNKER, BASE_2],
    ]) {
      const placed = fillAll(order);
      expect(setupOf(placed)).toHaveLength(ROSTER_SIZE);
      expect(validateSetup(map, PLAYER, setupOf(placed))).toEqual({ legal: true });
    }
  });

  /**
   * The invariant the store leans on: an illegal placement is never stored, and
   * the SAME reference comes back so the caller can tell nothing happened.
   * `startMatch` throws rather than start a match on an illegal board (§12), and
   * the client must never be the reason it does.
   */
  it('refuses an illegal hex and returns the same reference', () => {
    const placed: PlacementDraft = emptyPlacementDraft();
    const enemyGround = offsetToAxial({ col: 8, row: 1 });

    expect(withPlacementInSlot(map, PLAYER, placed, BUNKER, enemyGround)).toBe(
      placed,
    );
  });

  it('refuses a hex another of your own assets holds', () => {
    const sites = fillAll([BUNKER, DECOY]);
    const bunkerHex = placementSlots(sites)[BUNKER].hex!;

    expect(withPlacementInSlot(map, PLAYER, sites, DECOY, bunkerHex)).toBe(sites);
  });

  it('refuses a base inside the exclusion radius of a site, and vice versa', () => {
    const sites = fillAll([BUNKER, DECOY]);
    const siteHex = placementSlots(sites)[BUNKER].hex!;
    expect(withPlacementInSlot(map, PLAYER, sites, BASE_1, siteHex)).toBe(sites);

    const bases = fillAll([BASE_1]);
    const baseHex = placementSlots(bases)[BASE_1].hex!;
    expect(withPlacementInSlot(map, PLAYER, bases, BUNKER, baseHex)).toBe(bases);
  });

  it('refuses a slot id that does not exist', () => {
    const placed: PlacementDraft = emptyPlacementDraft();
    const somewhere = placementTargets(map, PLAYER, [], BUNKER)[0];
    expect(withPlacementInSlot(map, PLAYER, placed, 99, somewhere)).toBe(placed);
  });

  it('moves an already-placed asset instead of adding a fifth', () => {
    const full = fillAll();
    const elsewhere = placementTargets(map, PLAYER, full, BUNKER).find(
      (hex) => hexKey(hex) !== hexKey(placementSlots(full)[BUNKER].hex!),
    )!;

    const moved = withPlacementInSlot(map, PLAYER, full, BUNKER, elsewhere);
    expect(setupOf(moved)).toHaveLength(ROSTER_SIZE);
    expect(placementSlots(moved)[BUNKER].hex).toEqual(elsewhere);
    expect(validateSetup(map, PLAYER, setupOf(moved))).toEqual({ legal: true });
  });

  /**
   * Relocation writes back in place rather than removing and appending. If it
   * appended, moving base 1 would push it behind base 2 in submission order and
   * the two would silently swap names on screen.
   */
  it('does not renumber the other bases when one is moved', () => {
    const full = fillAll();
    const base2Hex = placementSlots(full)[BASE_2].hex!;

    const elsewhere = placementTargets(map, PLAYER, full, BASE_1).find(
      (hex) => hexKey(hex) !== hexKey(placementSlots(full)[BASE_1].hex!),
    )!;
    const moved = withPlacementInSlot(map, PLAYER, full, BASE_1, elsewhere);

    expect(placementSlots(moved)[BASE_1].hex).toEqual(elsewhere);
    expect(placementSlots(moved)[BASE_2].hex).toEqual(base2Hex);
  });

  /**
   * The end-to-end property: a setup built only through this module is one the
   * engine accepts. Several seeds, because the legal-hex lists depend on where
   * the generator put mountains — and bases first, which is the sequence the old
   * enforced order existed to forbid.
   */
  it('builds a setup the engine calls legal, on every board and for both sides', () => {
    for (const seed of [1, 42, 137, 5000]) {
      const board = generateMap(undefined, undefined, seed);
      for (const player of PLAYERS) {
        let placed: PlacementDraft = emptyPlacementDraft();
        for (const slotId of [BASE_1, BASE_2, DECOY, BUNKER]) {
          const targets = placementTargets(board, player, placed, slotId);
          expect(targets.length).toBeGreaterThan(0);
          placed = withPlacementInSlot(
            board,
            player,
            placed,
            slotId,
            targets[targets.length - 1],
          );
        }
        expect(validateSetup(board, player, setupOf(placed))).toEqual({ legal: true });
      }
    }
  });
});

describe('withoutSlot', () => {
  it('empties the slot it names and leaves the rest alone', () => {
    const full = fillAll();
    const without = withoutSlot(full, DECOY);
    const slots = placementSlots(without);

    // The draft keeps its shape — four slots, one now empty.
    expect(without).toHaveLength(ROSTER_SIZE);
    expect(setupOf(without)).toHaveLength(ROSTER_SIZE - 1);
    expect(slots[DECOY].hex).toBeNull();
    expect(slots[BUNKER].hex).toEqual(placementSlots(full)[BUNKER].hex);
    expect(slots[BASE_1].hex).toEqual(placementSlots(full)[BASE_1].hex);
    expect(slots[BASE_2].hex).toEqual(placementSlots(full)[BASE_2].hex);
  });

  it('returns the same reference when the slot is already empty', () => {
    const empty: PlacementDraft = emptyPlacementDraft();
    expect(withoutSlot(empty, BUNKER)).toBe(empty);
  });

  it('re-opens ground the removed asset was excluding', () => {
    const sites = fillAll([BUNKER, DECOY]);
    const narrowed = placementTargets(map, PLAYER, sites, BASE_1).length;
    const widened = placementTargets(
      map,
      PLAYER,
      withoutSlot(sites, DECOY),
      BASE_1,
    ).length;

    expect(widened).toBeGreaterThan(narrowed);
  });
});

// ---------------------------------------------------------------------------
// The exclusion overlay
// ---------------------------------------------------------------------------

describe('exclusionHexes', () => {
  it('is empty when nothing the rule pairs with has been placed', () => {
    expect(exclusionHexes(map, PLAYER, [], BASE_1)).toEqual([]);
    // Two bases down, placing the third... there is no third; placing a base
    // when only bases exist still excludes nothing, because the rule pairs a
    // base with a SITE.
    expect(exclusionHexes(map, PLAYER, fillAll([BASE_1]), BASE_2)).toEqual([]);
    // ...and two sites do not exclude each other either.
    expect(exclusionHexes(map, PLAYER, fillAll([BUNKER]), DECOY)).toEqual([]);
  });

  it('covers everything nearer than the radius to a site, when placing a base', () => {
    const sites = fillAll([BUNKER, DECOY]);
    const excluded = keysOf(exclusionHexes(map, PLAYER, sites, BASE_1));
    const zone = RULES.homeZoneRows[PLAYER];

    for (const tile of map.tiles) {
      if (tile.row < zone.min || tile.row > zone.max) continue;
      const hex = offsetToAxial({ col: tile.col, row: tile.row });
      const near = setupOf(sites).some(
        (s) => distance(s.hex, hex) < RULES.bunkerExclusionRadius,
      );
      expect(excluded.has(hexKey(hex))).toBe(near);
    }
  });

  /**
   * The other direction, which is what the free placement order made necessary:
   * with a base down, choosing a SITE must show the ring around that base.
   */
  it('covers the ring around a placed base, when placing a site', () => {
    const bases = fillAll([BASE_1]);
    const zone = RULES.homeZoneRows[PLAYER];

    for (const slotId of [BUNKER, DECOY]) {
      const excluded = keysOf(exclusionHexes(map, PLAYER, bases, slotId));
      expect(excluded.size).toBeGreaterThan(0);

      for (const tile of map.tiles) {
        if (tile.row < zone.min || tile.row > zone.max) continue;
        const hex = offsetToAxial({ col: tile.col, row: tile.row });
        const near = distance(setupOf(bases)[0].hex, hex) < RULES.bunkerExclusionRadius;
        expect(excluded.has(hexKey(hex))).toBe(near);
      }
    }
  });

  it('is exactly the home-zone ground missing from that slot’s highlight', () => {
    // The overlay's whole job: explain why those hexes are not offered. If the
    // two disagreed, the player would see a hex greyed out for no visible reason,
    // or an unexplained hole in the highlight.
    const sites = fillAll([BUNKER, DECOY]);
    const zone = RULES.homeZoneRows[PLAYER];

    const offered = keysOf(placementTargets(map, PLAYER, sites, BASE_1));
    const excluded = keysOf(exclusionHexes(map, PLAYER, sites, BASE_1));
    const taken = keysOf(setupOf(sites).map((s) => s.hex));
    const spawns = keysOf(ALL_SPAWN_HEXES.map(offsetToAxial));

    for (const tile of map.tiles) {
      if (tile.row < zone.min || tile.row > zone.max) continue;
      const key = hexKey(offsetToAxial({ col: tile.col, row: tile.row }));
      if (offered.has(key) || taken.has(key) || spawns.has(key)) continue;
      expect(excluded.has(key)).toBe(true);
    }
  });

  it('ignores the selected slot’s own asset', () => {
    // Otherwise a base already on the board would be excluded by itself the
    // moment a site was placed near... nothing. The rule is about the OTHER
    // assets, always.
    const full = fillAll();
    const baseHex = placementSlots(full)[BASE_1].hex!;
    const excluded = keysOf(exclusionHexes(map, PLAYER, full, BUNKER));

    expect(excluded.has(hexKey(baseHex))).toBe(true); // the other base's ring...
    expect(
      keysOf(exclusionHexes(map, PLAYER, full, BASE_1)).has(hexKey(baseHex)),
    ).toBe(false); // ...but not its own, when it is the one being moved
  });

  it('stays inside the placing player’s own home zone and on the board', () => {
    const sites = fillAll([BUNKER, DECOY]);
    const zone = RULES.homeZoneRows[PLAYER];

    for (const hex of exclusionHexes(map, PLAYER, sites, BASE_1)) {
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
   * way to draw the bunker's ring differently from the decoy's — the asymmetry is
   * unrepresentable rather than merely avoided.
   */
  it('reports no hex twice, even where two rings overlap', () => {
    const hexes = exclusionHexes(map, PLAYER, fillAll([BUNKER, DECOY]), BASE_1);
    expect(new Set(hexes.map(hexKey)).size).toBe(hexes.length);
  });
});
