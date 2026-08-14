// The setup screen, as the store sees it (build-order step 10b).
//
// Kept out of `match.test.ts` because that file's `beforeEach` auto-places to
// get straight to a playable match — these tests are about the screen it skips.

import { beforeEach, describe, expect, it } from 'vitest';
import { RULES } from '../sim/defs';
import { axialToOffset, hexKey, offsetToAxial } from '../sim/hex';
import { validateSetup } from '../sim/setup';
import { PLAYERS, type PlayerId } from '../sim/types';
import {
  DEFAULT_SEED,
  SANDBOX_DUMMY,
  SANDBOX_PLAYER,
  autoPlace,
  clearPlacements,
  clearSlot,
  matchStarted,
  matchStore,
  newMatch,
  pickHex,
  placeHex,
  resign,
  resolveRound,
  selectSlot,
  setOrder,
  startPlacedMatch,
  viewFor,
} from './match';
import {
  ROSTER_SIZE,
  placementSetup,
  placementSlots,
  placementTargets,
} from './placement';

/** Slot ids, by name, so the tests read as intent rather than as indexes. */
const BUNKER = 0;
const DECOY = 1;
const BASE_1 = 2;
const BASE_2 = 3;

beforeEach(() => {
  newMatch();
});

/**
 * The active seat's own placement draft (build-order step 10c made these
 * per-player). Every helper below goes through here, so the tests read as
 * "what the player at the screen sees" no matter which seat that is.
 */
function mine() {
  const { placed, activeSeat } = matchStore.getState();
  return placed[activeSeat];
}

/** Which roster slot the player at the screen is positioning. */
function activeSlot(): number {
  const { selectedSlot, activeSeat } = matchStore.getState();
  return selectedSlot[activeSeat];
}

/** The hexes the active player may legally use for the slot they have selected. */
function targets() {
  const { map, activeSeat, selectedSlot } = matchStore.getState();
  return placementTargets(map, activeSeat, mine(), selectedSlot[activeSeat]);
}

/** The player's roster, as the setup panel lists it. */
function slots() {
  return placementSlots(mine());
}

/** How many assets are on the board. */
function placedCount(): number {
  return placementSetup(mine()).length;
}

/** Place the whole roster by hand and start — the selection auto-advances, so
 *  this is four clicks and the Start button, and nothing else. */
function placeAll(): void {
  for (let i = 0; i < ROSTER_SIZE; i++) placeHex(targets()[0]);
  startPlacedMatch();
}

// ---------------------------------------------------------------------------
// The opening screen
// ---------------------------------------------------------------------------

describe('newMatch', () => {
  it('opens on the setup screen, not on a match', () => {
    expect(matchStarted()).toBe(false);
    expect(matchStore.getState().views).toBeNull();
    expect(viewFor(SANDBOX_PLAYER)).toBeNull();
    expect(placedCount()).toBe(0);
  });

  it('opens with the whole roster listed and the first slot selected', () => {
    // The roster is a fixed list from the first frame — it does not grow as
    // assets are placed, because the player picks which one they are positioning.
    expect(slots()).toHaveLength(ROSTER_SIZE);
    expect(slots().every((slot) => slot.hex === null)).toBe(true);
    expect(activeSlot()).toBe(BUNKER);
  });

  it('still has a board, because terrain is public (spec §11)', () => {
    const { map } = matchStore.getState();
    expect(map.tiles.length).toBe(map.width * map.height);
  });

  it('rolls a different board for a different seed', () => {
    const first = matchStore.getState().map;
    newMatch(DEFAULT_SEED + 1);
    expect(matchStore.getState().map).not.toEqual(first);
  });

  it('clears placements and returns to setup from a running match', () => {
    autoPlace();
    expect(matchStarted()).toBe(true);

    newMatch();
    expect(matchStarted()).toBe(false);
    expect(placedCount()).toBe(0);
    for (const player of PLAYERS) expect(viewFor(player)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Placing
// ---------------------------------------------------------------------------

describe('placeHex', () => {
  it('pre-selects the roster in order, so four clicks fill it', () => {
    const kinds: string[] = [];
    for (let i = 0; i < ROSTER_SIZE; i++) {
      const { activeSeat, selectedSlot } = matchStore.getState();
      kinds.push(slots()[selectedSlot[activeSeat]].kind);
      placeHex(targets()[0]);
    }

    expect(kinds).toEqual(['bunker', 'decoy', 'interceptor', 'interceptor']);
    expect(placedCount()).toBe(ROSTER_SIZE);
  });

  /**
   * Placement order is free (§12, changed 2026-08-13). The bases used to be
   * locked until both sites were down, because the ≥3 exclusion rule was checked
   * only from the base's side; it is symmetric now, so any asset may go first.
   */
  it('accepts the four assets in any order', () => {
    for (const slotId of [BASE_2, BUNKER, BASE_1, DECOY]) {
      selectSlot(slotId);
      placeHex(targets()[0]);
    }

    expect(placedCount()).toBe(ROSTER_SIZE);
    startPlacedMatch();
    expect(matchStarted()).toBe(true);
  });

  it('fills the slot that was selected, not the next one in the roster', () => {
    selectSlot(BASE_2);
    placeHex(targets()[0]);

    expect(slots()[BASE_2].hex).not.toBeNull();
    expect(slots()[BASE_1].hex).toBeNull();
    expect(slots()[BUNKER].hex).toBeNull();
  });

  it('advances the selection to the first still-empty slot', () => {
    selectSlot(BASE_1);
    placeHex(targets()[0]);
    // Bunker and decoy are still empty, so it goes back to the earliest gap
    // rather than marching on to base 2.
    expect(activeSlot()).toBe(BUNKER);
  });

  it('ignores an illegal hex — nothing is placed and the selection stays put', () => {
    // Deep in the enemy's home zone: outside this player's own zone entirely.
    placeHex(offsetToAxial({ col: 8, row: 1 }));

    expect(placedCount()).toBe(0);
    expect(activeSlot()).toBe(BUNKER);
    expect(matchStarted()).toBe(false);
  });

  it('offers only the placing player’s own home zone', () => {
    const zone = RULES.homeZoneRows[SANDBOX_PLAYER];
    for (const hex of targets()) {
      const { row } = axialToOffset(hex);
      expect(row).toBeGreaterThanOrEqual(zone.min);
      expect(row).toBeLessThanOrEqual(zone.max);
    }
  });

  /**
   * **The fourth placement does NOT start the match**, and that is a deliberate
   * reversal of how it worked while placement was a fixed sequence. Any asset can
   * now be repositioned at any time, so auto-starting on the last click would
   * snatch the board away at exactly the moment the player finally has the whole
   * thing in front of them to judge.
   */
  it('never starts the match on its own', () => {
    for (let i = 0; i < ROSTER_SIZE; i++) {
      placeHex(targets()[0]);
      expect(matchStarted()).toBe(false);
    }

    startPlacedMatch();
    expect(matchStarted()).toBe(true);
  });

  it('moves an already-placed asset instead of adding a fifth', () => {
    placeAllWithoutStarting();
    const before = slots()[BUNKER].hex!;

    selectSlot(BUNKER);
    const elsewhere = targets().find((hex) => hexKey(hex) !== hexKey(before))!;
    placeHex(elsewhere);

    expect(placedCount()).toBe(ROSTER_SIZE);
    expect(slots()[BUNKER].hex).toEqual(elsewhere);
  });

  it('builds a round-1 board with the full roster for both sides', () => {
    placeAll();

    for (const player of PLAYERS) {
      const view = viewFor(player);
      expect(view).not.toBeNull();
      expect(view!.round).toBe(1);
      expect(view!.phase).toBe('ORDER_PHASE');
      // 3 launchers + drone + bunker + decoy + 2 bases (spec §2).
      expect(view!.units).toHaveLength(8);
    }
  });

  it('puts the human’s own assets where they clicked', () => {
    placeAll();

    const own = viewFor(SANDBOX_PLAYER)!.units;
    for (const placement of placementSetup(mine())) {
      const unit = own.find((u) => hexKey(u.position) === hexKey(placement.hex));
      expect(unit?.kind).toBe(placement.kind);
    }
  });

  it('is inert once the match has started', () => {
    placeAll();
    const before = matchStore.getState().placed;

    placeHex(offsetToAxial({ col: 0, row: 18 }));
    expect(matchStore.getState().placed).toBe(before);
  });

  /**
   * The click router, one screen earlier: `pickHex` is what the canvas calls, and
   * before a match exists it must place rather than select. Without this the
   * board would be inert during setup and the panel would need a second, parallel
   * idea of what clicking a hex means.
   */
  it('is what a board click does before the match starts', () => {
    pickHex(targets()[0]);
    expect(placedCount()).toBe(1);
  });
});

/** Fill the roster but stay on the setup screen. */
function placeAllWithoutStarting(): void {
  for (let i = 0; i < ROSTER_SIZE; i++) placeHex(targets()[0]);
}

describe('selectSlot', () => {
  it('selects an empty slot and clears the board selection', () => {
    selectSlot(BASE_2);
    expect(activeSlot()).toBe(BASE_2);
    expect(matchStore.getState().selected).toBeNull();
  });

  it('selects a placed asset’s hex too, so the board shows what you picked up', () => {
    placeHex(targets()[0]);
    const bunkerHex = slots()[BUNKER].hex!;

    selectSlot(DECOY);
    selectSlot(BUNKER);
    expect(matchStore.getState().selected).toEqual(bunkerHex);
  });

  it('ignores a slot id that is not on the roster', () => {
    selectSlot(ROSTER_SIZE);
    expect(activeSlot()).toBe(BUNKER);
  });
});

describe('clearSlot / clearPlacements', () => {
  it('takes one asset back off the board and leaves the rest', () => {
    placeAllWithoutStarting();
    const decoyHex = slots()[DECOY].hex;

    clearSlot(BUNKER);
    expect(slots()[BUNKER].hex).toBeNull();
    expect(slots()[DECOY].hex).toEqual(decoyHex);
    expect(placedCount()).toBe(ROSTER_SIZE - 1);
  });

  it('selects the slot it emptied, ready to re-place it', () => {
    placeAllWithoutStarting();
    clearSlot(BASE_2);
    expect(activeSlot()).toBe(BASE_2);
  });

  it('does nothing to an empty slot', () => {
    const before = matchStore.getState().placed;
    clearSlot(BUNKER);
    expect(matchStore.getState().placed).toBe(before);
  });

  it('clears everything and reselects the bunker', () => {
    placeAllWithoutStarting();
    clearPlacements();

    expect(placedCount()).toBe(0);
    expect(activeSlot()).toBe(BUNKER);
  });

  it('cannot rewrite a setup once the match has started (§12 — secret and final)', () => {
    placeAll();
    const before = matchStore.getState().placed;

    clearSlot(BUNKER);
    clearPlacements();

    expect(matchStore.getState().placed).toBe(before);
    expect(matchStarted()).toBe(true);
  });
});

describe('startPlacedMatch', () => {
  it('refuses an incomplete roster', () => {
    placeHex(targets()[0]);
    startPlacedMatch();
    expect(matchStarted()).toBe(false);
  });

  it('starts on a full roster, with a setup the engine accepts', () => {
    placeAllWithoutStarting();
    startPlacedMatch();

    const { map, placed } = matchStore.getState();
    expect(matchStarted()).toBe(true);
    expect(
      validateSetup(map, SANDBOX_PLAYER, placementSetup(placed[SANDBOX_PLAYER])),
    ).toEqual({ legal: true });
  });

  it('is a no-op when a match is already running', () => {
    placeAll();
    const before = matchStore.getState().placed;
    startPlacedMatch();
    expect(matchStore.getState().placed).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Auto-place
// ---------------------------------------------------------------------------

describe('autoPlace', () => {
  it('starts a match with a setup the engine accepts', () => {
    autoPlace();

    const { map, placed } = matchStore.getState();
    expect(matchStarted()).toBe(true);
    expect(
      validateSetup(map, SANDBOX_PLAYER, placementSetup(placed[SANDBOX_PLAYER])),
    ).toEqual({ legal: true });
  });

  it('fills every roster slot, so the panel is not left half-empty', () => {
    autoPlace();
    expect(slots().every((slot) => slot.hex !== null)).toBe(true);
  });

  it('is a no-op once a match is running', () => {
    autoPlace();
    const before = matchStore.getState().placed;
    autoPlace();
    expect(matchStore.getState().placed).toBe(before);
  });

  /**
   * The CPU's board must not depend on how the human got to the start line —
   * that is what "same seed, same match" has to mean. It holds because the two
   * setup streams are keyed by player rather than by call order.
   */
  it('leaves the CPU’s setup identical whether the human auto-placed or not', () => {
    autoPlace();
    const auto = enemySites();

    newMatch();
    placeAll();
    expect(enemySites()).toEqual(auto);
  });
});

/**
 * Where the CPU's four assets are, read from its own view.
 *
 * This is the CPU's own board, which it is always allowed to see (§11 rule 1) —
 * the human's view of it stays empty, which the next describe checks.
 */
function enemySites(): string[] {
  return viewFor(SANDBOX_DUMMY)!
    .units.filter((u) => u.kind !== 'launcher' && u.kind !== 'drone')
    .map((u) => `${u.kind}@${hexKey(u.position)}`)
    .sort();
}

// ---------------------------------------------------------------------------
// What setup must not leak
// ---------------------------------------------------------------------------

describe('the setup screen and the visibility filter', () => {
  /**
   * The structural version of gotcha 30: the enemy's setup does not exist yet.
   * `beginMatch` generates the CPU's placements at match start rather than when
   * the board was rolled, so while the human is placing there is nothing in the
   * client to leak — no filter involved, and nothing to get wrong.
   */
  it('has no opponent setup anywhere in the store while placing', () => {
    placeHex(targets()[0]);

    const state = matchStore.getState();
    expect(state.views).toBeNull();
    // The only placements anywhere in the store are the human's own, and there
    // are as many as they have clicked. There is no field an opponent's setup
    // could live in until `beginMatch` builds one.
    expect(placedCount()).toBe(1);

    const zone = RULES.homeZoneRows[SANDBOX_PLAYER];
    for (const { hex } of placementSetup(state.placed[SANDBOX_PLAYER])) {
      const { row } = axialToOffset(hex);
      expect(row).toBeGreaterThanOrEqual(zone.min);
      expect(row).toBeLessThanOrEqual(zone.max);
    }
  });

  it('never shows the human where the CPU’s sites are', () => {
    placeAll();

    const view = viewFor(SANDBOX_PLAYER)!;
    // Own units only (spec §6) — no enemy unit is representable in this type.
    expect(view.units.every((u) => u.owner === SANDBOX_PLAYER)).toBe(true);
    // And nothing has been detected yet: no recon has flown, nothing has fired.
    expect(view.intel.staticReveals).toEqual([]);
    expect(view.intel.contacts).toEqual([]);
  });

  /**
   * The two sides' setups must not be locked to each other.
   *
   * Two identically-seeded streams do NOT produce mirrored coordinates — the
   * tempting thing to assert, and it would pass — because a half-turn maps P1's
   * column-major home-zone list onto P2's *reversed*. What they produce is worse
   * and subtler: both sides take the **same index** of their own legal list,
   * every time. A player who knew the algorithm could then read their own
   * bunker's position and derive the enemy's exactly, which in a
   * hidden-information game is the whole match. So the property to hold is that
   * the two indices come apart, and the assertion is over several seeds because
   * a correct implementation will still collide by chance about 1 seed in 96.
   */
  it('does not lock the two sides’ setups to the same index of their own lists', () => {
    let locked = 0;
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    for (const seed of seeds) {
      newMatch(seed);
      autoPlace();

      const { map } = matchStore.getState();
      const indexOfBunker = (player: PlayerId) => {
        // The bunker's own slot, against an empty draft: the full legal list.
        const list = placementTargets(map, player, [], BUNKER);
        const bunker = viewFor(player)!.units.find((u) => u.kind === 'bunker')!;
        return list.findIndex((hex) => hexKey(hex) === hexKey(bunker.position));
      };

      if (indexOfBunker(SANDBOX_PLAYER) === indexOfBunker(SANDBOX_DUMMY)) locked += 1;
    }

    expect(locked).toBeLessThan(seeds.length);
  });
});

// ---------------------------------------------------------------------------
// Match actions are inert before a match exists
// ---------------------------------------------------------------------------

describe('match actions before the match starts', () => {
  it('resolveRound does nothing', () => {
    resolveRound();
    expect(matchStarted()).toBe(false);
    for (const player of PLAYERS) expect(logFor(player)).toEqual([]);
  });

  it('resign does nothing', () => {
    resign(SANDBOX_PLAYER);
    expect(matchStarted()).toBe(false);
  });

  it('setOrder does nothing', () => {
    setOrder({
      type: 'MOVE',
      unitId: `${SANDBOX_PLAYER}-launcher-1`,
      destination: offsetToAxial({ col: 2, row: 15 }),
    });
    expect(matchStore.getState().draft[SANDBOX_PLAYER]).toEqual({});
  });
});

/** Local, because this file otherwise has no reason to import the log. */
function logFor(player: PlayerId) {
  return matchStore.getState().logs[player];
}
