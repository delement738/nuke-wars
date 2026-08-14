// CLIENT STATE — the match store (build-order step 9).
//
// **This module is the only place in the client that ever holds an unfiltered
// `GameState`, and it holds it in a module-private variable that nothing can
// import.** That is the single guarantee step 8 could not give itself: the
// visibility filter prevents a leak only for callers that actually call it, so
// handing `GameCanvas` a raw state would bypass every promise `visibility.ts`
// makes without failing one test in `src/sim/` (CLAUDE.md gotcha 34).
//
// Here it is structural instead of remembered. `truth` below is not exported,
// is not in the store, and has no accessor. Everything that leaves this file has
// been through `filterForPlayer` / `filterEventsForPlayer` — there is no code
// path that returns anything else, and adding one would mean editing this file
// on purpose rather than reaching for a field that happened to be in scope.
//
// In hotseat one machine necessarily holds both players' redacted views (that is
// what a pass-the-screen handoff *is*, spec §6). The store therefore keeps both,
// keyed by player, and the presentation layer only ever reads the `viewer`'s.
// In V1.5 the same split becomes physical: the server keeps `truth`, and each
// client receives only its own `VisibleGameState` — this file becomes two,
// unchanged in what they do.
//
// Layering: this is client state, so it may import `src/sim/` freely, and
// `src/sim/` may never import it. React lives in `./useMatch`, so this module
// stays a plain testable object — the same reason the engine is dependency-free.

import { hexKey, type Hex } from '../sim/hex';
import { generateMap, makeRng, type MapData } from '../sim/map';
import { resolve } from '../sim/resolve';
import { startMatch, type PlayerSetup } from '../sim/setup';
import {
  PLAYERS,
  opponentOf,
  type GameEvent,
  type GameState,
  type Order,
  type Outcome,
  type PlayerId,
  type UnitId,
  type VisibleEvent,
  type VisibleGameState,
} from '../sim/types';
import { filterEventsForPlayer, filterForPlayer } from '../sim/visibility';
import { createStore } from 'zustand/vanilla';
import { cpuOrders, type CpuDifficulty } from './cpu';
import {
  allDecided,
  draftOrders,
  isLegalOrder,
  orderFor,
  orderableUnits,
  withHold,
  withOrder,
  withoutOrder,
  EMPTY_DRAFT,
  type OrderDraft,
  type OrderMode,
} from './orders';
import {
  emptyPlacementDraft,
  type PlacementDraft,
  firstEmptySlot,
  placementComplete,
  placementDraftOf,
  placementSetup,
  placementSlots,
  withPlacementInSlot,
  withoutSlot,
} from './placement';
import { sandboxSetup } from './sandbox';
import {
  humanSeats,
  isHotseat,
  nextSeat,
  openingSeat,
  SOLO_SEATS,
  type Seating,
} from './seats';

/**
 * The side a human plays in the sandbox; the other is the CPU (spec §8 step 9
 * shipped it as a static dummy that never ordered anything — `src/state/cpu.ts`
 * replaced that with a real, difficulty-tiered opponent).
 *
 * These survive 10c as the *solo* seating's two roles, and nothing below
 * branches on them any more: who is human is `seats`, and whose turn it is
 * is `activeSeat` (see `./seats`). They remain because a handful of UI strings
 * and tests legitimately mean "the seat the CPU plays in solo".
 */
export const SANDBOX_PLAYER: PlayerId = 'p1';
export const SANDBOX_DUMMY: PlayerId = opponentOf(SANDBOX_PLAYER);

/** Map seed a fresh sandbox match uses when none is given. */
export const DEFAULT_SEED = 42;

/** Difficulty a fresh sandbox match starts at. */
export const DEFAULT_DIFFICULTY: CpuDifficulty = 'medium';

/**
 * One line of a player's permanent history (spec §6, §11).
 *
 * The round is stamped on here because events do not carry one — the engine
 * emits the log for a single resolution and the client is what keeps it. It is
 * the round that was *resolved*, not the one the state moved on to, so a launch
 * detected in round 4 reads as round 4 forever after.
 *
 * The log is append-only: map contacts expire after one order phase, log entries
 * never do (§11). Expiring a marker must never delete a line from here.
 */
export interface LogEntry {
  round: number;
  event: VisibleEvent;
}

/**
 * Everything the presentation layer may read. Note what is *not* here: the
 * unfiltered state, both players' orders, and anything keyed by a raw `Unit`
 * belonging to the enemy.
 */
export interface MatchState {
  /** Map seed of the running match — shown in the HUD so a board is repeatable. */
  seed: number;
  /**
   * The board (build-order step 10b).
   *
   * Held at the top level, unredacted, and outliving `truth`: it exists from the
   * moment a match is *set up*, which is before there is a `GameState` to filter.
   * That is not a hole in the visibility filter — **terrain is public** (spec
   * §11), and `VisibleGameState.map` is already this same object by reference,
   * since the filter has nothing to hide here. Hidden information covers assets,
   * never tiles (CLAUDE.md gotcha 7).
   */
  map: MapData;
  /**
   * Who supplies each player's orders (build-order step 10c).
   *
   * Solo is `{ p1: 'human', p2: 'cpu' }` and hotseat is two humans. Everything
   * that used to assume "p1 is the human" reads this instead, which is what let
   * `resolveRound` lose its branch: each seat is asked the same question and
   * only the source of the answer differs.
   */
  seats: Seating;
  /**
   * Whose turn it is to **act** — the player whose orders are being drafted and
   * whose placements a board click positions (build-order step 10c).
   *
   * Deliberately distinct from `viewer`, which is whose picture is *drawn*. In
   * hotseat they are always equal. In solo they come apart the moment the debug
   * viewer switch is used to look at the CPU's board, and keeping them separate
   * is what stops that from turning the order builder into a way to order the
   * CPU's units (gotcha 41d) — `orderingView` reads this one, never `viewer`.
   */
  activeSeat: PlayerId;
  /**
   * **The screen is blanked, waiting for this player to sit down** — or null
   * when someone is already at it (build-order step 10c).
   *
   * While it is set, `App` renders the handoff prompt and *nothing else*: no
   * canvas, no panels. That is what re-establishes the secrecy 10b got for free.
   * Until now "the setup screen cannot leak the opponent's placements" held
   * because no enemy setup existed in the client at all (gotcha 43); in hotseat
   * one genuinely does, so the guarantee becomes two rules instead — no hook
   * takes a `PlayerId` from a caller (gotcha 36, see `./useMatch`), and `viewer`
   * cannot change without passing through this blank.
   *
   * Null throughout a solo match: there is nobody to pass the screen to, and
   * spectating the CPU must not blank it. That is why this is its own field
   * rather than derived from `viewer !== activeSeat`, which is a legal and
   * perfectly ordinary state in solo play.
   */
  handoff: PlayerId | null;
  /**
   * The human's secret placements, one entry per roster slot (spec §12).
   *
   * Populated on the setup screen and left in place once the match starts, where
   * each is simply a record of where that player put their own four assets —
   * their own knowledge, which they are always allowed to see (§11 rule 1).
   *
   * **One per player since 10c, and gotcha 36's discipline now applies**: in
   * hotseat both drafts sit in the store at once, so the only thing that may
   * read one is a hook keyed on `viewer`. There is deliberately no accessor
   * that takes a `PlayerId` from a caller.
   */
  placed: Record<PlayerId, PlacementDraft>;
  /**
   * Which roster slot each player's setup screen is positioning — the asset a
   * board click will place or move (spec §12; placement order is free).
   *
   * Never null while placing: it starts at the bunker and advances to the first
   * empty slot after each placement, so a player who just wants to click four
   * times never has to choose one. Once the roster is full it stays on the slot
   * last touched, and a further click relocates that asset — which is the point
   * of the explicit Start button.
   */
  selectedSlot: Record<PlayerId, number>;
  /** How a `'cpu'` seat plays. A solo-mode control, same as the viewer switch. */
  difficulty: CpuDifficulty;
  /**
   * Whose redacted view is on screen.
   *
   * In hotseat this is the player at the keyboard, and only the handoff changes
   * it. In solo it is additionally a debug control, which is exactly why
   * `activeSeat` exists separately from it.
   */
  viewer: PlayerId;
  /** The hex the player clicked, or null. Presentation state, not game state. */
  selected: Hex | null;
  /** Which of the human's own units is being ordered, or null. Kept alongside
   *  `selected` rather than derived from it because the drone may hover over a
   *  launcher (spec §2), and a stacked hex would otherwise be ambiguous. */
  selectedUnitId: UnitId | null;
  /** The hex under the cursor, or null. Presentation state — it drives the
   *  flight-path preview, which needs a destination before one is committed. */
  hovered: Hex | null;
  /**
   * Each player's queued orders for this round, keyed by unit so the §9
   * one-order-per-unit budget is structural (`./orders`).
   *
   * In solo only one of the two is ever written: the CPU decides its own orders
   * inside `resolveRound` from its own redacted view and never drafts. In
   * hotseat both are live at once and hidden orders are the entire point of the
   * game (§3, simultaneous), so gotcha 36's discipline applies here exactly as
   * it does to `placed` — read only through a hook keyed on `viewer`.
   */
  draft: Record<PlayerId, OrderDraft>;
  /** Which order kind the panel is composing for the selected unit, or null.
   *  In the store rather than the panel because the canvas draws from it too. */
  orderMode: OrderMode | null;
  /**
   * Both players' redacted boards, rebuilt from `truth` after every change —
   * and **null until the match starts** (build-order step 10b).
   *
   * There is genuinely no board to redact while the human is still placing their
   * assets: `startMatch` is what turns two secret setups into a `GameState`
   * (§12), so before it runs there is nothing for `filterForPlayer` to project.
   * A placeholder view would mean inventing engine state in the client, which is
   * the one thing this layer must never do.
   *
   * This is therefore also **the setup screen's discriminator**, and deliberately
   * the only one: `views === null` *is* "we are still placing". A separate
   * `stage` field would be a second fact that could disagree with this one.
   */
  views: Record<PlayerId, VisibleGameState> | null;
  /** Both players' permanent event histories, filtered on the way in. */
  logs: Record<PlayerId, LogEntry[]>;
}

// ---------------------------------------------------------------------------
// The truth (module-private — see the header)
// ---------------------------------------------------------------------------

/**
 * **Null while the human is still placing their assets** (build-order step 10b).
 *
 * A `GameState` only exists on the far side of `startMatch`, which needs two
 * complete secret setups (§12) — so for the whole setup screen there is no truth
 * to hold, and the honest representation of that is nothing rather than a
 * half-built board. Every action below that touches the match guards on it.
 */
let truth: GameState | null = null;

/**
 * A fresh board for `seed`.
 *
 * Width and height are left at their defaults: board size is a spec §7 number
 * that belongs to the sim, and repeating it here would be a second place for it
 * to be wrong.
 */
function freshMap(seed: number): MapData {
  return generateMap(undefined, undefined, seed);
}

/**
 * Which stream a sandbox setup is drawn from (build-order step 10b).
 *
 * Per player rather than one shared stream, for two reasons. It must not be two
 * streams from one *seed* — that would make each side's setup a deterministic
 * function of the other's (see `sandboxSetup`) — and keying on the player rather
 * than on call order means the CPU's board at a given seed is the same whether
 * or not the human pressed Auto-place, which is what "same seed, same match"
 * has to mean to be worth anything.
 *
 * The offset keeps this clear of `resolveRound`'s `seed * 100000 + round` space,
 * which runs to `RULES.roundCap`.
 */
const SETUP_RNG_OFFSET = 90000;

function setupRng(seed: number, player: PlayerId): () => number {
  return makeRng(seed * 100000 + SETUP_RNG_OFFSET + PLAYERS.indexOf(player));
}

/** Both redacted views of the current truth (spec §6 layer 2). */
function viewsOf(state: GameState): Record<PlayerId, VisibleGameState> {
  return {
    p1: filterForPlayer(state, 'p1'),
    p2: filterForPlayer(state, 'p2'),
  };
}

/**
 * The per-player fields of a fresh setup screen (build-order step 10c).
 *
 * Written once and reused by the store's initial state, `newMatch` and
 * `setSeating`, so "a new match starts with nothing placed and nothing drafted"
 * is one definition rather than three that could drift apart — which matters
 * more now than it did at 10b, because forgetting to clear the *other* player's
 * draft would carry one player's secret placements into the next match.
 */
function freshDrafts(): Pick<MatchState, 'placed' | 'selectedSlot' | 'draft'> {
  return {
    placed: { p1: emptyPlacementDraft(), p2: emptyPlacementDraft() },
    selectedSlot: { p1: 0, p2: 0 },
    draft: { p1: EMPTY_DRAFT, p2: EMPTY_DRAFT },
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * A vanilla Zustand store, so this module never imports React (`./useMatch`
 * supplies the hooks). It is exported for those hooks and for tests; the state
 * inside it is filtered by construction, so exporting it leaks nothing.
 */
export const matchStore = createStore<MatchState>()(() => ({
  seed: DEFAULT_SEED,
  map: freshMap(DEFAULT_SEED),
  // The client opens in solo, so the default experience is unchanged by 10c:
  // one human placing four assets against a CPU. Hotseat is opted into.
  seats: SOLO_SEATS,
  activeSeat: SANDBOX_PLAYER,
  handoff: null,
  ...freshDrafts(),
  difficulty: DEFAULT_DIFFICULTY,
  viewer: SANDBOX_PLAYER,
  selected: null,
  selectedUnitId: null,
  hovered: null,
  orderMode: null,
  // The client opens on the setup screen, not on a match: nothing is playable
  // until the human has placed their bunker, decoy and two bases (§12).
  views: null,
  logs: { p1: [], p2: [] },
}));

/**
 * Publish the current truth: rebuild both views, and append this resolution's
 * events to both logs *through the filter*.
 *
 * Every event the client ever sees passes through here, including the one the
 * store synthesises itself (see `resign`). Nothing gets to skip the filter
 * because it was "obviously public" — that judgement is spec §6's to make, and
 * it is already written down in `filterEventsForPlayer`.
 */
function publish(round: number, events: readonly GameEvent[]): void {
  if (!truth) return; // no match — nothing to project and nothing to log
  const { logs } = matchStore.getState();

  matchStore.setState({
    views: viewsOf(truth),
    logs: {
      p1: appendLog(logs.p1, round, filterEventsForPlayer(events, 'p1')),
      p2: appendLog(logs.p2, round, filterEventsForPlayer(events, 'p2')),
    },
  });
}

/**
 * Returns the *same array* when a player saw nothing this round, so a component
 * subscribed to one player's log does not re-render for a round that told them
 * nothing. Both players' logs are rebuilt on every publish, and an unchanged
 * reference is what makes that cheap.
 */
function appendLog(
  log: LogEntry[],
  round: number,
  events: readonly VisibleEvent[],
): LogEntry[] {
  if (events.length === 0) return log;
  return [...log, ...events.map((event) => ({ round, event }))];
}

// ---------------------------------------------------------------------------
// Actions — the only way anything changes
// ---------------------------------------------------------------------------

/**
 * Roll a fresh board and return to the setup screen (build-order step 10b).
 *
 * It no longer starts a match: a match begins when the human finishes placing
 * (`placeHex`) or skips it (`autoPlace`). Everything from the previous match —
 * both logs, the selection, any drafted orders, and the previous placements — is
 * cleared, because none of it means anything on a new board.
 */
export function newMatch(seed: number = DEFAULT_SEED): void {
  const { seats } = matchStore.getState();
  truth = null;

  // The seating deliberately survives: "New map" in a two-player game should
  // roll a board, not silently drop you back into solo. Everything else goes,
  // including *both* players' placements — carrying one over would put a hex a
  // player chose on one board onto a different one.
  const opening = openingSeat(seats, () => true) ?? SANDBOX_PLAYER;

  matchStore.setState({
    seed,
    map: freshMap(seed),
    ...freshDrafts(),
    activeSeat: opening,
    viewer: opening,
    // Hotseat re-opens on a handoff, so the first player is asked to take the
    // screen before their empty board is drawn. Solo has nobody to pass to.
    handoff: isHotseat(seats) ? opening : null,
    selected: null,
    selectedUnitId: null,
    hovered: null,
    orderMode: null,
    views: null,
    logs: { p1: [], p2: [] },
  });
}

// ---------------------------------------------------------------------------
// Seating and the pass-the-screen handoff (build-order step 10c)
// ---------------------------------------------------------------------------

/**
 * Choose who fills the two seats, and start a fresh setup (step 10c).
 *
 * It abandons whatever was in progress rather than trying to convert it: a
 * half-built solo setup means nothing once a second human is placing, and a
 * running match cannot grow a player. Changing the seating is choosing what
 * kind of game to play, which is a thing you do before one starts.
 */
export function setSeating(seats: Seating): void {
  matchStore.setState({ seats });
  newMatch(matchStore.getState().seed);
}

/**
 * The player at the screen has confirmed they are the right one (step 10c).
 *
 * This is the *only* action that changes `viewer` in hotseat, and it always
 * moves `activeSeat` with it — so "the picture on screen belongs to the person
 * whose turn it is" holds by construction. `activeSeat` is deliberately not
 * moved when the handoff is *scheduled*: until someone presses the button, the
 * previous player is still nominally the one at the keyboard, and nothing is
 * drawn either way.
 */
export function takeScreen(): void {
  const { handoff } = matchStore.getState();
  if (!handoff) return;

  matchStore.setState({
    viewer: handoff,
    activeSeat: handoff,
    handoff: null,
    selected: null,
    selectedUnitId: null,
    hovered: null,
    orderMode: null,
  });
}

/** Whether `player` still has a decision to make this round — the skip test the
 *  handoff needs so a dead-hand round does not strand itself (see `./seats`). */
function hasOrdersToGive(player: PlayerId): boolean {
  const { views, draft } = matchStore.getState();
  const view = views?.[player];
  return view !== undefined && !allDecided(view, draft[player]);
}

/**
 * Hand the screen to `player`, or — in solo, where there is nobody to hand it
 * to — simply make them the active seat.
 *
 * Every turn change goes through here, which is what keeps the blank and the
 * seat change from ever getting out of step.
 */
function passTo(player: PlayerId): void {
  const { seats } = matchStore.getState();

  if (!isHotseat(seats)) {
    matchStore.setState({ activeSeat: player, viewer: player });
    return;
  }

  matchStore.setState({
    handoff: player,
    selected: null,
    selectedUnitId: null,
    hovered: null,
    orderMode: null,
  });
}

// ---------------------------------------------------------------------------
// Setup placement (build-order step 10b)
// ---------------------------------------------------------------------------

/**
 * The `SETUP -> ORDER_PHASE` edge of spec §5's state machine, from the client's
 * side: the human's finished setup plus one invented for the CPU become the
 * board round 1 is played on.
 *
 * The CPU's setup is generated **here, at match start** — not when the map was
 * rolled. That is what makes "the setup screen cannot leak the opponent's
 * placements" structural rather than careful: while the human is placing, no
 * enemy setup exists anywhere in the client to leak. The same reasoning as
 * gotcha 30, one level up from the validator.
 *
 * `startMatch` re-validates both setups and throws on an illegal one (§12), so
 * the human's placements are held to exactly the rules the highlight offered
 * them — the UI is not trusted to have got it right, it is checked.
 */
function beginMatch(setups: Record<PlayerId, PlayerSetup>): void {
  truth = startMatch(matchStore.getState().map, setups);

  matchStore.setState({
    // Round-trip every setup back through the draft shape, so a CPU seat's
    // invented placements and a human's hand-placed ones are held identically.
    // Each player still only ever sees their own (see `MatchState.placed`).
    placed: { p1: placementDraftOf(setups.p1), p2: placementDraftOf(setups.p2) },
    views: viewsOf(truth),
    selected: null,
    selectedUnitId: null,
    hovered: null,
  });

  // Round 1 opens on whoever has orders to give. In solo that is the human; in
  // hotseat it is a handoff, because the board that just appeared is somebody's
  // in particular.
  const { seats } = matchStore.getState();
  passTo(openingSeat(seats, hasOrdersToGive) ?? SANDBOX_PLAYER);
}

/**
 * Every seat's finished setup: the human ones taken from their drafts, the CPU
 * ones invented here (build-order step 10c generalises 10b's single call).
 *
 * A CPU seat's setup is still generated at **match start** rather than when the
 * map was rolled, which is what kept 10b's "the setup screen cannot leak the
 * opponent's placements" structural (gotcha 43). In hotseat that guarantee can
 * no longer be structural — the first player's four hexes genuinely are in the
 * store while the second places — so it is carried by the handoff blank and the
 * viewer-keyed hooks instead. Against a CPU it still costs nothing to keep, so
 * it is kept.
 */
function allSetups(): Record<PlayerId, PlayerSetup> {
  const { seed, map, seats, placed } = matchStore.getState();

  const setups: Record<PlayerId, PlayerSetup> = { p1: [], p2: [] };
  for (const player of PLAYERS) {
    setups[player] =
      seats[player] === 'human'
        ? placementSetup(placed[player])
        : sandboxSetup(map, player, setupRng(seed, player));
  }
  return setups;
}

/**
 * Choose which of your four assets you are positioning (spec §12).
 *
 * Any slot, at any time — placement order is free, so this is the whole input
 * the setup screen needs beyond the board itself. Selecting a slot that is
 * already placed selects its hex too, so the board shows you which asset you
 * have picked up.
 */
export function selectSlot(slotId: number): void {
  if (truth) return;

  const { activeSeat, placed, selectedSlot } = matchStore.getState();
  const slot = placementSlots(placed[activeSeat])[slotId];
  if (!slot) return;

  matchStore.setState({
    selectedSlot: { ...selectedSlot, [activeSeat]: slotId },
    selected: slot.hex,
  });
}

/**
 * Put the selected slot's asset on `hex` — placing it, or **moving it** if that
 * slot is already on the board (spec §12).
 *
 * An illegal hex is dropped rather than stored — `withPlacementInSlot` checks it
 * against the real §12 validator — so nothing downstream has to defend against a
 * setup containing one.
 *
 * Selection then advances to the first still-empty slot, which is what lets a
 * player who does not care about order simply click four times. When none is
 * empty it stays put, so the last asset placed is the one a further click moves.
 *
 * **This does NOT start the match**, and that is a deliberate reversal of how it
 * worked when placement was a fixed sequence. Back then the fourth click was
 * unambiguously "I am done". Now that any asset can be repositioned at any time,
 * auto-starting on the fourth placement would snatch the board away at exactly
 * the moment the player finally has the whole thing in front of them to judge.
 * `startPlacedMatch` is the explicit commitment instead.
 */
export function placeHex(hex: Hex): void {
  if (truth) return; // the match has started; placement is over

  const { map, activeSeat, placed, selectedSlot } = matchStore.getState();
  const mine = placed[activeSeat];
  const slot = selectedSlot[activeSeat];

  // Validated for the ACTIVE SEAT, not for a fixed player: in hotseat the same
  // click means "put P2's bunker here" on the second pass, and the home zone it
  // is checked against is the far end of the board (§7).
  const next = withPlacementInSlot(map, activeSeat, mine, slot, hex);
  if (next === mine) return; // illegal — the same reference means nothing moved

  matchStore.setState({
    placed: { ...placed, [activeSeat]: next },
    selectedSlot: {
      ...selectedSlot,
      [activeSeat]: firstEmptySlot(next) ?? slot,
    },
    selected: hex,
  });
}

/** Take the selected slot's asset back off the board. Refused once the match has
 *  started — a setup is secret and final the moment the board is built (§12). */
export function clearSlot(slotId: number): void {
  if (truth) return;
  const { activeSeat, placed, selectedSlot } = matchStore.getState();
  const next = withoutSlot(placed[activeSeat], slotId);
  if (next === placed[activeSeat]) return;

  matchStore.setState({
    placed: { ...placed, [activeSeat]: next },
    selectedSlot: { ...selectedSlot, [activeSeat]: slotId },
    selected: null,
  });
}

/** Take everything back off the board and start the setup over. Clears only the
 *  active seat's roster — in hotseat the other player's is not yours to reset. */
export function clearPlacements(): void {
  if (truth) return;
  const { activeSeat, placed, selectedSlot } = matchStore.getState();
  matchStore.setState({
    placed: { ...placed, [activeSeat]: emptyPlacementDraft() },
    selectedSlot: { ...selectedSlot, [activeSeat]: 0 },
    selected: null,
  });
}

/**
 * Commit the setup and begin the match (spec §12's `SETUP -> ORDER_PHASE` edge).
 *
 * A no-op on an incomplete roster rather than a throw: the button is disabled
 * until all four are down, so reaching here early is a UI event, not a caller
 * bug — the same reasoning as `resolveRound` on a finished match.
 */
export function startPlacedMatch(): void {
  if (truth) return;

  const { seats, activeSeat, placed } = matchStore.getState();
  if (!placementComplete(placed[activeSeat])) return;

  // In hotseat, "Start" from the first player means "I am done placing" — the
  // match cannot begin until the other human has hidden their assets too. The
  // seat rotation is the same one the order phase uses, so a player who has
  // already finished is skipped rather than asked twice.
  const waiting = nextSeat(
    seats,
    activeSeat,
    (player) => !placementComplete(placed[player]),
  );
  if (waiting) {
    passTo(waiting);
    return;
  }

  beginMatch(allSetups());
}

/**
 * Skip placing by hand: take the sandbox fixture's setup and start (step 10b).
 *
 * A convenience for the times you are testing something that is not placement,
 * and deliberately the *same* function the CPU's setup comes from — so the board
 * it produces is one the engine would have accepted from a human, not a
 * special case that could quietly diverge from the rules.
 */
export function autoPlace(): void {
  if (truth) return;

  const { seed, map, seats, placed, selectedSlot } = matchStore.getState();

  // Fill every *unfinished* human roster, then start. In hotseat that means one
  // press can stand in for both players, which is what you want when you are
  // testing something that is not placement — and it leaves an already-placed
  // player's own choices alone.
  const next = { ...placed };
  const slots = { ...selectedSlot };
  for (const player of humanSeats(seats)) {
    if (placementComplete(next[player])) continue;
    next[player] = placementDraftOf(sandboxSetup(map, player, setupRng(seed, player)));
    slots[player] = 0;
  }

  matchStore.setState({ placed: next, selectedSlot: slots });
  beginMatch(allSetups());
}

/**
 * Resolve one round: the human's drafted orders against the CPU's.
 *
 * The human's side comes from `draft` (build-order step 10a filled in the seam
 * step 9 left as an unconditional `[]`). Undecided units simply contribute
 * nothing, which is a perfectly legal round — a launcher with no order holds and
 * a drone with no order hovers (§3) — so this is safe to call at any point in
 * the order phase, with a full draft or an empty one.
 *
 * The CPU is handed `filterForPlayer(truth, SANDBOX_DUMMY)`, never `truth` —
 * the exact same redacted view a human in that seat would get — so playing
 * against it is not playing against an opponent who can see through the fog
 * (`src/state/cpu.ts`'s whole design rests on this). Its `rng` is derived from
 * the match seed and the round number so a match at a fixed seed and
 * difficulty always plays out identically, matching the rest of this
 * codebase's determinism discipline.
 *
 * One call covers both kinds of round: `resolve` reads `state.phase` and runs a
 * normal round or the dead-hand volley accordingly (§5), so this function does
 * not know the difference and must not learn it — nor does the CPU call above,
 * since `cpuOrders` reads `view.phase` the same way.
 *
 * A finished match is a no-op rather than a throw. The engine throws on a
 * GAME_OVER state and is right to — the phase is its own to set — but a button
 * pressed twice is a UI event, not a caller bug.
 */
export function resolveRound(): void {
  if (!truth || truth.phase === 'GAME_OVER') return;

  // Stamped before resolving: `resolve` hands back the *next* round's number
  // (and freezes it on game over), while these events belong to the round that
  // was just played.
  const round = truth.round;

  const { seed, seats, difficulty, draft } = matchStore.getState();

  // One question, asked of every seat: what are this player's orders? A human
  // seat answers from its draft and a CPU seat decides on the spot — and the
  // CPU is handed `filterForPlayer(truth, player)`, never `truth`, so the two
  // kinds of seat are given exactly the same information about the board.
  const submitted: Record<PlayerId, readonly Order[]> = { p1: [], p2: [] };
  for (const player of PLAYERS) {
    submitted[player] =
      seats[player] === 'human'
        ? draftOrders(draft[player])
        : cpuOrders(
            filterForPlayer(truth, player),
            difficulty,
            player,
            makeRng(seed * 100000 + round),
          );
  }

  const result = resolve(truth, submitted.p1, submitted.p2, seed);
  truth = result.state;

  // Both drafts belong to the round that has just been played. Clearing them
  // here rather than in the UI is what makes "orders are a one-round
  // commitment" (§3) hold no matter which path resolved the round — the button,
  // or a completed draft resolving itself.
  matchStore.setState({
    draft: { p1: EMPTY_DRAFT, p2: EMPTY_DRAFT },
    orderMode: null,
    selected: null,
    selectedUnitId: null,
    hovered: null,
  });
  publish(round, result.events);

  // Open the next round on whoever has orders to give. A finished match passes
  // to nobody: the result is public, so there is no reason to blank the screen
  // and every reason to leave it up (spec §4).
  if (truth.phase !== 'GAME_OVER') {
    const opening = openingSeat(matchStore.getState().seats, hasOrdersToGive);
    if (opening) passTo(opening);
  }
}

/**
 * **The player at the screen is finished for this round** (build-order 10c).
 *
 * The one action behind the HUD's main button, and behind a draft completing
 * itself. In solo it resolves immediately, exactly as `resolveRound` always
 * did. In hotseat it passes the screen, and only the *last* human seat's turn
 * ending resolves the round — which is what keeps orders simultaneous (§3): a
 * player who pressed the button early must not thereby submit an empty draft
 * on their opponent's behalf.
 *
 * Resolving early is still legal and still available. Any unit the active
 * player has not decided simply holds (§3).
 */
export function endTurn(): void {
  if (!truth || truth.phase === 'GAME_OVER') return;

  const { seats, activeSeat } = matchStore.getState();
  const waiting = nextSeat(seats, activeSeat, hasOrdersToGive);

  if (waiting) passTo(waiting);
  else resolveRound();
}

// ---------------------------------------------------------------------------
// Order drafting (build-order step 10a)
// ---------------------------------------------------------------------------

/**
 * The board every drafted order is judged against.
 *
 * Deliberately `SANDBOX_PLAYER`'s view and NOT the current `viewer`'s. The
 * viewer switch is a debug control, so flipping it to look at the CPU's picture
 * must not turn the order builder into a way to order the CPU's units. Because a
 * `VisibleGameState` holds only its owner's units (spec §6), an order naming any
 * unit but the human's fails validation at the `find` — "you may only order your
 * own pieces" is structural rather than a check that could be forgotten.
 *
 * The UI additionally disables order entry while spectating, so the two guards
 * are independent: one stops a wrong order being *stored*, the other stops it
 * being *offered*.
 */
function orderingView(): VisibleGameState | null {
  const { views, activeSeat } = matchStore.getState();
  return views?.[activeSeat] ?? null;
}

/** The active seat's own draft — the one every action below reads and writes. */
function activeDraft(): OrderDraft {
  const { draft, activeSeat } = matchStore.getState();
  return draft[activeSeat];
}

/** `draft` with the active seat's entry replaced, leaving the other player's
 *  alone — in hotseat theirs is a secret this action has no business touching. */
function withActiveDraft(next: OrderDraft): Record<PlayerId, OrderDraft> {
  const { draft, activeSeat } = matchStore.getState();
  return { ...draft, [activeSeat]: next };
}

/**
 * End the active seat's turn the moment every one of its orderable units has
 * been decided.
 *
 * This is what makes a round advance on its own instead of waiting for a
 * button. It is called only from the two actions that *add* a decision, and it
 * leans entirely on `allDecided`'s empty-set guard — during the opponent's
 * dead-hand round the active player has no orderable units, and "all zero of
 * them are decided" would otherwise be true forever (see the note in
 * `./orders`).
 *
 * Since 10c it calls `endTurn` rather than resolving directly, so in hotseat a
 * completed draft passes the screen instead of submitting an empty draft for
 * the player who has not had their turn yet.
 */
function advanceIfComplete(): void {
  const view = orderingView();
  if (view && allDecided(view, activeDraft())) endTurn();
}

/**
 * Queue an order, replacing whatever that unit was going to do.
 *
 * An illegal order is dropped rather than stored (`withOrder` checks it against
 * the real sim validators), so nothing downstream has to defend against a draft
 * containing one. Clearing `orderMode` afterwards returns the panel from
 * "pick a target" to "pick a unit", which is the loop the player is actually in.
 */
export function setOrder(order: Order): void {
  const view = orderingView();
  if (!view) return;

  const next = withOrder(view, activeDraft(), order);
  matchStore.setState({
    draft: withActiveDraft(next),
    orderMode: null,
    hovered: null,
  });
  advanceIfComplete();
}

/**
 * Mark a unit as deliberately holding — a launcher that stays put, a drone that
 * hovers and watches its own corridor (spec §3, §11).
 *
 * It submits nothing; its whole purpose is to say "I am finished with this unit"
 * so a complete draft can resolve the round. Without it, a player who wanted to
 * hold anything could never complete one.
 */
export function holdUnit(unitId: UnitId): void {
  const view = orderingView();
  const unit = view?.units.find((u) => u.id === unitId);
  if (!view || !unit) return;

  const next = withHold(view, activeDraft(), unit);
  matchStore.setState({
    draft: withActiveDraft(next),
    orderMode: null,
    hovered: null,
  });
  advanceIfComplete();
}

/** Un-decide a unit. Never ends the turn — removing a decision cannot complete
 *  a draft, and a player undoing an order wants to keep ordering. */
export function clearOrder(unitId: UnitId): void {
  matchStore.setState({
    draft: withActiveDraft(withoutOrder(activeDraft(), unitId)),
    orderMode: null,
  });
}

/** Discard the active seat's queued decisions for this round. */
export function clearDraft(): void {
  matchStore.setState({ draft: withActiveDraft(EMPTY_DRAFT), orderMode: null });
}

/** Enter or leave target-picking for the selected unit. */
export function setOrderMode(mode: OrderMode | null): void {
  matchStore.setState({ orderMode: mode, hovered: null });
}

/** Track the cursor, so a flight can be previewed before it is committed. */
export function hoverHex(hex: Hex | null): void {
  matchStore.setState({ hovered: hex });
}

/**
 * Resign the match on `player`'s behalf.
 *
 * **Capitulation is not a fact about the board** (spec §4): no arrangement of
 * units implies a resignation, so `adjudicate` can never return it and
 * `resolve()` never emits it. Whatever owns the match sets it — in V1 that is
 * this store, in V1.5 the server — which is why this is the one action that
 * writes `truth` without the engine's help.
 *
 * It still emits a `GAME_OVER` event and still routes it through the filter, so
 * a resigned match ends with the same log entry and the same terminal state as
 * one the engine ended. Nothing downstream needs a special case.
 */
export function resign(player: PlayerId): void {
  if (!truth || truth.phase === 'GAME_OVER') return;

  const outcome: Outcome = { type: 'CAPITULATION', winner: opponentOf(player) };
  truth = { ...truth, phase: 'GAME_OVER', outcome };
  matchStore.setState({
    draft: { p1: EMPTY_DRAFT, p2: EMPTY_DRAFT },
    orderMode: null,
    // The match is over and the outcome is public (§4), so the screen stops
    // being anybody's secret — a pending handoff would blank a result both
    // players are entitled to look at.
    handoff: null,
  });
  publish(truth.round, [{ type: 'GAME_OVER', outcome }]);
}

/**
 * Switch which player's redacted view is rendered (a **solo-mode debug
 * control**).
 *
 * The selection is cleared because it means nothing on the other player's board;
 * the **draft is deliberately left alone**, so glancing at the CPU's picture and
 * coming back does not silently throw away the orders you had queued. Entry is
 * disabled while spectating instead (see `orderingView`).
 *
 * **Refused outright in hotseat** (build-order step 10c). Against a CPU,
 * spectating the other side is a debug affordance with nobody to cheat; with a
 * second human it is simply a button that shows you your opponent's hidden
 * board. The handoff is the only thing that may move `viewer` there, and this
 * guard is what makes that sentence true rather than merely intended — the HUD
 * also hides the buttons, which is the second of two independent guards, the
 * same pairing `orderingView` uses.
 */
export function setViewer(viewer: PlayerId): void {
  if (isHotseat(matchStore.getState().seats)) return;

  matchStore.setState({
    viewer,
    selected: null,
    selectedUnitId: null,
    orderMode: null,
    hovered: null,
  });
}

/** Change how the CPU plays, effective from the next `resolveRound()` call. */
export function setDifficulty(difficulty: CpuDifficulty): void {
  matchStore.setState({ difficulty });
}

/**
 * Select a hex, or clear the selection with null.
 *
 * It also picks up whichever of the viewer's own orderable units is standing
 * there, so clicking a launcher on the map is enough to start ordering it. A
 * hex can legitimately hold two of your units — the drone is on the air layer
 * and may hover directly over a launcher (spec §2) — so this takes the first
 * orderable one and the panel offers the other explicitly. Ambiguity is resolved
 * in the panel, never guessed at here.
 */
export function selectHex(hex: Hex | null): void {
  const view = orderingView();
  const key = hex ? hexKey(hex) : null;
  const unit =
    view === null || key === null
      ? undefined
      : orderableUnits(view).find((u) => hexKey(u.position) === key);

  matchStore.setState({
    selected: hex,
    selectedUnitId: unit?.id ?? null,
    orderMode: null,
    hovered: null,
  });
}

/** Select one of your own units by id — the panel's way past a stacked hex. */
export function selectUnit(unitId: UnitId): void {
  const unit = orderingView()?.units.find((u) => u.id === unitId);
  if (!unit) return;
  matchStore.setState({
    selected: unit.position,
    selectedUnitId: unit.id,
    orderMode: null,
    hovered: null,
  });
}

/**
 * A click on the map, routed.
 *
 * The render layer reports *that a hex was clicked* and nothing more — deciding
 * what a click means is state's job, not drawing's (CLAUDE.md's render rule). If
 * the player is picking a target and the hex is a legal one, the click commits
 * the order; otherwise it selects the hex, which is also how you back out of
 * target-picking by clicking somewhere irrelevant.
 *
 * While spectating as the CPU it can only ever select, because `orderMode` is
 * cleared by `setViewer` and the panel offers no way to set it again.
 *
 * **Before the match starts a click places an asset** (build-order step 10b).
 * Same principle, one screen earlier: the canvas reports a click and this decides
 * what it meant. The setup screen therefore needs no click handler of its own,
 * and cannot grow one that disagrees with this about what a hex click does.
 */
export function pickHex(hex: Hex): void {
  const view = orderingView();
  if (!view) {
    placeHex(hex);
    return;
  }

  const { orderMode, selectedUnitId } = matchStore.getState();
  const unit = selectedUnitId
    ? view.units.find((u) => u.id === selectedUnitId)
    : undefined;

  if (orderMode && unit) {
    const order = orderFor(unit, orderMode, hex);
    if (isLegalOrder(view, order)) {
      setOrder(order);
      return;
    }
  }
  selectHex(hex);
}

// ---------------------------------------------------------------------------
// Reads — for tests and for the hooks in ./useMatch
// ---------------------------------------------------------------------------

/**
 * What `player` is allowed to see of the board right now — or **null while the
 * setup screen is still collecting placements**, because there is no board yet
 * (see `MatchState.views`).
 */
export function viewFor(player: PlayerId): VisibleGameState | null {
  return matchStore.getState().views?.[player] ?? null;
}

/** Whether a match is running. False on the setup screen. */
export function matchStarted(): boolean {
  return matchStore.getState().views !== null;
}

/** `player`'s permanent history — every event they were allowed to see (§11). */
export function logFor(player: PlayerId): readonly LogEntry[] {
  return matchStore.getState().logs[player];
}
