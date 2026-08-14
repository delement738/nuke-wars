// The pass-the-screen hotseat handoff (build-order step 10c).
//
// Two humans on one machine. The store necessarily holds both players' redacted
// views, both secret setups and both order drafts (spec §6, gotcha 36) — so the
// tests that matter most here are the ones about what is *on screen*, not about
// what is in memory. Those are the last two blocks.

import { beforeEach, describe, expect, it } from 'vitest';
import { RULES } from '../sim/defs';
import { axialToOffset } from '../sim/hex';
import { PLAYERS, type PlayerId } from '../sim/types';
import {
  SANDBOX_PLAYER,
  autoPlace,
  clearDraft,
  endTurn,
  holdUnit,
  matchStarted,
  matchStore,
  newMatch,
  placeHex,
  resign,
  setSeating,
  setViewer,
  startPlacedMatch,
  takeScreen,
  viewFor,
} from './match';
import { ROSTER_SIZE, placementSetup, placementTargets } from './placement';
import { orderableUnits } from './orders';
import { HOTSEAT_SEATS, SOLO_SEATS } from './seats';

beforeEach(() => {
  setSeating(HOTSEAT_SEATS);
});

// ---------------------------------------------------------------------------
// Helpers — each acts as whoever is currently at the screen
// ---------------------------------------------------------------------------

function state() {
  return matchStore.getState();
}

/** The active seat's own legal placement hexes for its selected slot. */
function targets() {
  const { map, activeSeat, placed, selectedSlot } = state();
  return placementTargets(map, activeSeat, placed[activeSeat], selectedSlot[activeSeat]);
}

/** How many assets `player` has on the board. */
function placedCount(player: PlayerId): number {
  return placementSetup(state().placed[player]).length;
}

/** Fill the active seat's roster by clicking the first legal hex four times. */
function placeRoster(): void {
  for (let i = 0; i < ROSTER_SIZE; i++) placeHex(targets()[0]);
}

/** Take the screen, place a full roster, and commit. */
function seatPlacesAndCommits(): void {
  takeScreen();
  placeRoster();
  startPlacedMatch();
}

/** Decide every one of the active seat's orderable units by holding them all,
 *  which ends that player's turn through the auto-advance path. */
function holdEverything(): void {
  const view = viewFor(state().activeSeat);
  if (!view) throw new Error('no match');
  for (const unit of orderableUnits(view)) holdUnit(unit.id);
}

/** Get to a playable hotseat match without hand-placing anything. */
function startHotseatMatch(): void {
  autoPlace();
}

// ---------------------------------------------------------------------------
// Setup: two players hide their assets in turn
// ---------------------------------------------------------------------------

describe('hotseat setup', () => {
  it('opens on a handoff to p1 rather than on a board', () => {
    expect(state().handoff).toBe('p1');
    expect(matchStarted()).toBe(false);
  });

  it('hands over to p2 when p1 commits, instead of starting the match', () => {
    seatPlacesAndCommits();

    expect(state().handoff).toBe('p2');
    expect(matchStarted()).toBe(false);
    expect(placedCount('p1')).toBe(ROSTER_SIZE);
    expect(placedCount('p2')).toBe(0);
  });

  it('starts the match once the second player commits', () => {
    seatPlacesAndCommits(); // p1
    seatPlacesAndCommits(); // p2

    expect(matchStarted()).toBe(true);
    for (const player of PLAYERS) {
      expect(viewFor(player)!.round).toBe(1);
      expect(viewFor(player)!.units).toHaveLength(8);
    }
  });

  /**
   * The board that appears when the match begins is somebody's in particular,
   * so round 1 opens on a pass back to the first player rather than on whatever
   * the second player was looking at.
   *
   * Written from a state where no handoff is pending — p2 is sitting at the
   * screen having just placed — because `newMatch` already opens on a handoff
   * to p1, and a test that skipped straight to `autoPlace` would pass whether or
   * not the match start re-established one. (It did, and the mutation check
   * caught it.)
   */
  it('re-establishes the handoff when the match begins', () => {
    seatPlacesAndCommits(); // p1
    takeScreen(); // p2 sits down
    placeRoster();
    expect(state().handoff).toBeNull(); // nobody is waiting: p2 is right here

    startPlacedMatch();

    expect(matchStarted()).toBe(true);
    expect(state().handoff).toBe('p1');
  });

  /**
   * **Each player places in their OWN home zone** (spec §7). The screen is
   * visited twice and the second visit is P2's, so a setup screen still keyed to
   * a fixed player would offer P2 the south — P1's ground — and the engine would
   * throw on the finished setup.
   */
  it('validates the second player’s placements against their own zone', () => {
    seatPlacesAndCommits(); // p1
    takeScreen();
    placeRoster();

    const zone = RULES.homeZoneRows.p2;
    for (const { hex } of placementSetup(state().placed.p2)) {
      const { row } = axialToOffset(hex);
      expect(row).toBeGreaterThanOrEqual(zone.min);
      expect(row).toBeLessThanOrEqual(zone.max);
    }
  });

  it('gives the two players disjoint ground, so neither can block the other', () => {
    seatPlacesAndCommits();
    seatPlacesAndCommits();

    const rows = (player: PlayerId) =>
      placementSetup(state().placed[player]).map((p) => axialToOffset(p.hex).row);

    expect(Math.min(...rows('p1'))).toBeGreaterThan(Math.max(...rows('p2')));
  });

  it('auto-place fills both rosters and starts', () => {
    autoPlace();

    expect(matchStarted()).toBe(true);
    for (const player of PLAYERS) expect(placedCount(player)).toBe(ROSTER_SIZE);
  });
});

// ---------------------------------------------------------------------------
// Turn order: both players draft before anything resolves
// ---------------------------------------------------------------------------

describe('hotseat rounds', () => {
  beforeEach(() => {
    startHotseatMatch();
  });

  it('opens round 1 on a handoff', () => {
    expect(state().handoff).toBe('p1');
    expect(viewFor('p1')!.round).toBe(1);
  });

  /**
   * **The load-bearing rule of the whole session.** Orders are simultaneous
   * (§3), so the first player finishing must not resolve the round — that would
   * submit an empty draft on the second player's behalf, and hand the first
   * player a free round every time.
   */
  it('passes the screen when the first player finishes — it does NOT resolve', () => {
    takeScreen();
    holdEverything();

    expect(state().handoff).toBe('p2');
    expect(viewFor('p1')!.round).toBe(1);
  });

  it('resolves only when the second player finishes', () => {
    takeScreen();
    holdEverything(); // p1 done -> handoff to p2
    takeScreen();
    holdEverything(); // p2 done -> resolve

    for (const player of PLAYERS) expect(viewFor(player)!.round).toBe(2);
  });

  it('opens the next round on a handoff back to the first player', () => {
    takeScreen();
    holdEverything();
    takeScreen();
    holdEverything();

    expect(state().handoff).toBe('p1');
  });

  it('the manual button ends a turn rather than the round', () => {
    takeScreen();
    endTurn();

    expect(state().handoff).toBe('p2');
    expect(viewFor('p1')!.round).toBe(1);
  });

  it('clears BOTH drafts when the round resolves', () => {
    takeScreen();
    holdEverything();
    takeScreen();
    holdEverything();

    expect(state().draft.p1).toEqual({});
    expect(state().draft.p2).toEqual({});
  });

  it('keeps the two drafts apart while both are live', () => {
    takeScreen();
    holdEverything(); // p1's draft is full, then the turn ends

    // p1's decisions are still in the store while p2 drafts — they have to be,
    // the round has not resolved — but they are p1's alone.
    expect(Object.keys(state().draft.p1).length).toBeGreaterThan(0);
    expect(state().draft.p2).toEqual({});
  });

  it('clearDraft discards only the draft of the player at the screen', () => {
    takeScreen();
    holdEverything(); // p1 decides everything; the turn passes to p2
    const p1Draft = state().draft.p1;
    expect(Object.keys(p1Draft).length).toBeGreaterThan(0);

    takeScreen(); // p2 sits down
    const [first] = orderableUnits(viewFor('p2')!);
    holdUnit(first.id); // a partial draft — not enough to end p2's turn
    expect(state().draft.p2).not.toEqual({});

    clearDraft();

    // p2's own draft is gone; p1's is untouched, by reference.
    expect(state().draft.p2).toEqual({});
    expect(state().draft.p1).toBe(p1Draft);
  });
});

// ---------------------------------------------------------------------------
// What is on screen — the secrecy the handoff exists to provide
// ---------------------------------------------------------------------------

describe('hotseat secrecy', () => {
  /**
   * `viewer` is what every presentation hook keys off (`./useMatch`), so this is
   * the assertion standing in for "the panels and the canvas show the right
   * player's board". No hook takes a `PlayerId` from a caller, precisely so that
   * this one fact decides all of them (gotcha 36).
   */
  it('moves the viewer with the active seat, and only via the handoff', () => {
    expect(state().handoff).toBe('p1');
    takeScreen();
    expect(state().viewer).toBe('p1');
    expect(state().activeSeat).toBe('p1');

    placeRoster();
    startPlacedMatch();

    // Between turns the screen is blanked and the viewer has NOT yet moved —
    // `App` renders the handoff prompt and nothing else while this holds.
    expect(state().handoff).toBe('p2');

    takeScreen();
    expect(state().viewer).toBe('p2');
    expect(state().activeSeat).toBe('p2');
  });

  /**
   * The solo debug viewer switch is a cheat with a human opponent — it draws
   * their hidden board on demand. `setViewer` refuses in hotseat and the HUD
   * additionally hides the buttons: two independent guards, one stopping the
   * state change and one stopping it being offered.
   */
  it('refuses the debug viewer switch outright', () => {
    startHotseatMatch();
    takeScreen();

    setViewer('p2');

    expect(state().viewer).toBe('p1');
    expect(state().activeSeat).toBe('p1');
  });

  it('still allows the viewer switch in solo, where there is nobody to cheat', () => {
    setSeating(SOLO_SEATS);
    autoPlace();

    setViewer('p2');
    expect(state().viewer).toBe('p2');
    // ...but the order builder still refuses to serve the spectated seat, which
    // is `activeSeat`'s whole job (gotcha 41d).
    expect(state().activeSeat).toBe(SANDBOX_PLAYER);
  });

  it('never leaves a handoff pending on a finished match', () => {
    startHotseatMatch();
    takeScreen();
    resign('p1');

    // The outcome is public (§4), so blanking the screen would be hiding a
    // result both players are entitled to read.
    expect(state().handoff).toBeNull();
    expect(viewFor('p1')!.outcome).not.toBeNull();
  });

  /**
   * The same rule, from the one direction the UI cannot currently produce: a
   * resignation arriving while the screen is mid-handoff.
   *
   * No button can do this today — `App` renders only the handoff prompt while
   * one is pending, so the HUD's Resign is unreachable then. It is asserted
   * anyway because the store is a plain module whose actions are meant to be
   * safe in any order, and because the alternative is a finished match stuck
   * behind a blank screen that no longer has a turn to hand over.
   */
  it('clears a pending handoff if the match ends during one', () => {
    startHotseatMatch();
    expect(state().handoff).toBe('p1');

    resign('p1');

    expect(state().handoff).toBeNull();
    expect(viewFor('p2')!.outcome).not.toBeNull();
  });

  it('endTurn is inert once the match is over', () => {
    startHotseatMatch();
    takeScreen();
    resign('p1');

    const round = viewFor('p1')!.round;
    endTurn();

    expect(viewFor('p1')!.round).toBe(round);
    expect(state().handoff).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Switching modes
// ---------------------------------------------------------------------------

describe('setSeating', () => {
  it('abandons a running match and returns to placement', () => {
    startHotseatMatch();
    expect(matchStarted()).toBe(true);

    setSeating(SOLO_SEATS);

    expect(matchStarted()).toBe(false);
    for (const player of PLAYERS) expect(placedCount(player)).toBe(0);
  });

  it('solo opens with no handoff at all', () => {
    setSeating(SOLO_SEATS);

    expect(state().handoff).toBeNull();
    expect(state().activeSeat).toBe(SANDBOX_PLAYER);
  });

  it('newMatch keeps the seating — a new board is not a new kind of game', () => {
    newMatch(9);

    expect(state().seats).toEqual(HOTSEAT_SEATS);
    expect(state().handoff).toBe('p1');
    expect(state().seed).toBe(9);
  });
});
