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
  matchStarted,
  matchStore,
  newMatch,
  pickHex,
  placeHex,
  resign,
  resolveRound,
  setOrder,
  undoPlacement,
  viewFor,
} from './match';
import { ROSTER_SIZE, placementStep, placementTargets } from './placement';

beforeEach(() => {
  newMatch();
});

/** The hexes the human may legally use for their current placement step. */
function targets() {
  const { map, placed } = matchStore.getState();
  return placementTargets(map, SANDBOX_PLAYER, placed);
}

/** Place the whole roster by hand, taking the first legal hex each time. */
function placeAll(): void {
  for (let i = 0; i < ROSTER_SIZE; i++) placeHex(targets()[0]);
}

// ---------------------------------------------------------------------------
// The opening screen
// ---------------------------------------------------------------------------

describe('newMatch', () => {
  it('opens on the setup screen, not on a match', () => {
    expect(matchStarted()).toBe(false);
    expect(matchStore.getState().views).toBeNull();
    expect(viewFor(SANDBOX_PLAYER)).toBeNull();
    expect(matchStore.getState().placed).toEqual([]);
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
    expect(matchStore.getState().placed).toEqual([]);
    for (const player of PLAYERS) expect(viewFor(player)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Placing
// ---------------------------------------------------------------------------

describe('placeHex', () => {
  it('walks the §12 placement order: bunker, decoy, then both bases', () => {
    const kinds: string[] = [];
    for (let i = 0; i < ROSTER_SIZE; i++) {
      kinds.push(placementStep(matchStore.getState().placed)!.kind);
      placeHex(targets()[0]);
    }

    expect(kinds).toEqual(['bunker', 'decoy', 'interceptor', 'interceptor']);
  });

  it('ignores an illegal hex — nothing is placed and the step does not advance', () => {
    // Deep in the enemy's home zone: outside this player's own zone entirely.
    const enemyGround = offsetToAxial({ col: 8, row: 1 });
    placeHex(enemyGround);

    expect(matchStore.getState().placed).toEqual([]);
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
   * The auto-start rule, and the reason there is no "Begin match" button: the
   * fourth placement is the last decision the setup screen is waiting for. Same
   * shape as a complete order draft resolving its own round (step 10a).
   */
  it('starts the match on the last placement, and not before', () => {
    for (let i = 0; i < ROSTER_SIZE - 1; i++) {
      placeHex(targets()[0]);
      expect(matchStarted()).toBe(false);
    }

    placeHex(targets()[0]);
    expect(matchStarted()).toBe(true);
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

    const { placed } = matchStore.getState();
    const own = viewFor(SANDBOX_PLAYER)!.units;

    for (const placement of placed) {
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
    expect(matchStore.getState().placed).toHaveLength(1);
  });
});

describe('undoPlacement / clearPlacements', () => {
  it('takes back the last placement and re-opens that step', () => {
    placeHex(targets()[0]);
    placeHex(targets()[0]);
    expect(placementStep(matchStore.getState().placed)!.kind).toBe('interceptor');

    undoPlacement();
    expect(matchStore.getState().placed).toHaveLength(1);
    expect(placementStep(matchStore.getState().placed)!.kind).toBe('decoy');
  });

  it('does nothing on an empty setup', () => {
    undoPlacement();
    expect(matchStore.getState().placed).toEqual([]);
  });

  it('clears back to the bunker', () => {
    placeHex(targets()[0]);
    placeHex(targets()[0]);
    clearPlacements();

    expect(matchStore.getState().placed).toEqual([]);
    expect(placementStep(matchStore.getState().placed)!.kind).toBe('bunker');
  });

  it('cannot rewrite a setup once the match has started (§12 — it is secret and final)', () => {
    placeAll();
    const before = matchStore.getState().placed;

    undoPlacement();
    clearPlacements();

    expect(matchStore.getState().placed).toBe(before);
    expect(matchStarted()).toBe(true);
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
    expect(validateSetup(map, SANDBOX_PLAYER, placed)).toEqual({ legal: true });
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
    expect(state.placed).toHaveLength(1);
    const zone = RULES.homeZoneRows[SANDBOX_PLAYER];
    for (const { hex } of state.placed) {
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
        const list = placementTargets(map, player, []); // the bunker is placed first
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
    expect(matchStore.getState().draft).toEqual({});
  });
});

/** Local, because this file otherwise has no reason to import the log. */
function logFor(player: PlayerId) {
  return matchStore.getState().logs[player];
}
