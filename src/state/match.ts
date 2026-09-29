// CLIENT STATE — the match store (build-order step 9; split in V1.5 Session 5).
//
// **This store never holds an unfiltered `GameState`.** Since the authority split
// the truth lives in a `MatchAuthority` (`./authority`), and the only thing that
// reaches this module from it is a `MatchUpdate` — one player's filtered view,
// their filtered slice of the events, and (at GAME_OVER only) the reveal. The
// renderer reads this store, so it can see nothing the visibility filter did not
// pass (CLAUDE.md gotchas 34, 35).
//
// What this module does own is everything about *drawing and driving* a match:
// placements and drafts while they are being made, whose turn it is at the
// screen, the handoff blank, the logs, banners and replays built from updates.
// It talks to the authority through three calls (setup, orders, resign) and
// receives updates through `receive`. Today the authority is the in-process
// `createLocalAuthority`; in Session 6 it becomes a server, and this file is not
// supposed to notice.
//
// In hotseat one machine necessarily holds both players' redacted views (that is
// what a pass-the-screen handoff *is*, spec §6). The store therefore keeps both,
// keyed by player, and the presentation layer only ever reads the `viewer`'s.
//
// Layering: this is client state, so it may import `src/sim/` freely, and
// `src/sim/` may never import it. React lives in `./useMatch`, so this module
// stays a plain testable object — the same reason the engine is dependency-free.

import { hexKey, type Hex } from '../sim/hex';
import { generateMap, type MapData } from '../sim/map';
import {
  PLAYERS,
  opponentOf,
  type Order,
  type PlayerId,
  type Unit,
  type UnitId,
  type VisibleEvent,
  type VisibleGameState,
} from '../sim/types';
import { createStore } from 'zustand/vanilla';
import {
  createLocalAuthority,
  setupRng,
  type LocalAuthority,
  type MatchUpdates,
} from './authority';
import type { CpuDifficulty } from './cpu';
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
import { battleReports, type BattleReport } from './reports';
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
 * One player's not-yet-watched resolution (presentation phase, session 1).
 *
 * The render layer plays `events` back on top of `from` and then settles on the
 * current view. Both halves are already filtered: `from` is the view this player
 * had *before* the round resolved, and `events` is exactly the slice their log
 * received — so a replay cannot show anything the log does not (spec §6).
 *
 * `from` is the backdrop, never something to diff against. What changed is read
 * off the events, which is the architecture rule: animate from the event log.
 */
export interface Replay {
  /** The round that was resolved — the same number its log entries carry. */
  round: number;
  from: VisibleGameState;
  events: readonly VisibleEvent[];
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
   * Held at the top level, unredacted, and outliving the match: it exists from the
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
   * each is simply a record of where that player put their own three assets —
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
   * The players' redacted boards, as the authority last sent them — and **null
   * until the match starts** (build-order step 10b). Partial because an update
   * names the seats it is for; the local authority always sends both, a network
   * client will only ever have its own.
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
  views: Partial<Record<PlayerId, VisibleGameState>> | null;
  /** Both players' permanent event histories, filtered on the way in. */
  logs: Record<PlayerId, LogEntry[]>;
  /**
   * Undismissed battle-report banners, per player (V1.1 step 1).
   *
   * Both players' queues are filled by the same `receive` that appends to
   * `logs`, because in hotseat a resolution produces news for two people at once
   * and the second one is not at the screen yet — their banners wait for them.
   * `dismissReport` pops the *viewer's* head, so a player can only ever clear
   * their own (gotcha 36); the queue for the other seat is untouched.
   *
   * Unlike `logs`, this is transient: it holds what has not been read yet, not
   * a history. The permanent record is `logs`, always.
   */
  reports: Record<PlayerId, BattleReport[]>;
  /**
   * Each player's pending replay of the last resolution, or null (presentation
   * phase, session 1).
   *
   * **Per player, for the same reason as `reports`**: in hotseat one resolution
   * produces a replay for two people and the second is not at the screen yet.
   * Theirs waits in their slot until they take the screen, and `finishReplay`
   * clears only the viewer's — so P1 watching or skipping cannot use up P2's.
   * Nothing plays during a handoff because `App` unmounts the canvas then
   * (gotchas 58, 62); this field only says what is *waiting* to play.
   */
  replay: Record<PlayerId, Replay | null>;
  /**
   * **The end-of-match reveal**: every enemy piece where it actually stood when
   * the match ended — keyed by the *viewing* player, so `finalReveal.p1` is
   * p2's units. **Null for the whole match and non-null only once the phase is
   * GAME_OVER**, which is the one moment hidden information stops being hidden:
   * the outcome is public (§4) and nothing more can be decided with it.
   *
   * Straight from the truth, including `kind: 'decoy'` — the decoy mask protects
   * a living secret, and the point of the reveal is "that was the decoy; the real
   * bunker was over there". The authority sets it on every update once the match
   * is over, so both endings (the engine's verdict and `resign`) get it without a
   * special case. This is the single piece of the truth that ever reaches the
   * store, and gotcha 73 says why it may.
   */
  finalReveal: Partial<Record<PlayerId, readonly Unit[]>> | null;
}

// ---------------------------------------------------------------------------
// The authority (module-private — see the header and `./authority`)
// ---------------------------------------------------------------------------

/**
 * Who resolves the running match — **null while the players are still placing**
 * (build-order step 10b), because a match only exists on the far side of every
 * seat's setup (§12). Created at match start with the seating and difficulty
 * then in force, and dropped by `newMatch`.
 *
 * Module-private for the same reason `truth` used to be (gotcha 35): the local
 * authority holds the unfiltered state, and nothing outside this file may hold
 * a handle that could ask it anything.
 *
 * Typed as the local kind because it is the only kind until Session 6; the
 * store uses nothing of it beyond `MatchAuthority` except `advance`, which only
 * a seating with no human seat needs.
 */
let authority: LocalAuthority | null = null;

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
  // one human placing three assets against a CPU. Hotseat is opted into.
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
  // until the human has placed their bunker, decoy and base (§12).
  views: null,
  logs: { p1: [], p2: [] },
  reports: { p1: [], p2: [] },
  replay: { p1: null, p2: null },
  finalReveal: null,
}));

/**
 * Take in what the authority says happened — the match starting, a round
 * resolving, or a resignation — and move the screen on.
 *
 * The one entry point for anything the authority sends, so the three moments
 * share one path: each player's view is replaced, their filtered events are
 * appended to their log, and their banners and replay are built from that same
 * slice. None of it is derived from anything but the update (spec §6).
 *
 * Every draft and selection is then cleared, because they belonged to the board
 * that was just replaced: orders are a one-round commitment (§3) whichever path
 * resolved the round. Finally the screen passes to whoever has orders to give. A
 * finished match passes to nobody and lifts any handoff: the result is public,
 * so there is no reason to blank the screen and every reason to leave it up (§4).
 */
function receive(updates: MatchUpdates): void {
  const { seats, views: before, logs, reports, replay, finalReveal } =
    matchStore.getState();

  const next = {
    views: { ...before },
    logs: { ...logs },
    reports: { ...reports },
    replay: { ...replay },
    finalReveal: { ...finalReveal },
  };
  let over = false;
  for (const player of PLAYERS) {
    const update = updates[player];
    if (!update) continue;
    const { round, view, events } = update;
    next.views[player] = view;
    next.logs[player] = appendLog(logs[player], round, events);
    // Banners come from the same filtered slice the log gets, and from the
    // player's own roster (V1.1 step 1; see `reports.ts`). Queued rather than
    // shown: the other seat may be mid-walk to the machine.
    next.reports[player] = queueReports(reports[player], events, player, view.units, round);
    // The replay plays that same slice over the view this player had a moment
    // ago. On the opening update there is no earlier view, so nothing plays.
    next.replay[player] = replayOf(before?.[player], round, events);
    if (update.finalReveal) next.finalReveal[player] = update.finalReveal;
    if (view.phase === 'GAME_OVER') over = true;
  }

  matchStore.setState({
    ...next,
    finalReveal: Object.keys(next.finalReveal).length > 0 ? next.finalReveal : null,
    draft: { p1: EMPTY_DRAFT, p2: EMPTY_DRAFT },
    orderMode: null,
    selected: null,
    selectedUnitId: null,
    hovered: null,
  });

  if (over) {
    matchStore.setState({ handoff: null });
    return;
  }
  // The opening update always hands the screen to someone, because the board
  // that just appeared is somebody's in particular. After a resolution nobody may
  // have orders to give (a dead-hand round the CPU is firing), and then the
  // screen stays where it is.
  const opening = openingSeat(seats, hasOrdersToGive);
  if (opening) passTo(opening);
  else if (!before) passTo(SANDBOX_PLAYER);
}

/**
 * A player's replay of this resolution, or null when there is nothing to play —
 * no previous board to play it on, or no events they were allowed to see.
 *
 * A newer resolution replaces an unwatched older one rather than queueing behind
 * it: the backdrop of the old one is no longer the board the new one starts
 * from, so playing both in sequence would be a picture the state never held.
 */
function replayOf(
  from: VisibleGameState | undefined,
  round: number,
  events: readonly VisibleEvent[],
): Replay | null {
  if (!from || events.length === 0) return null;
  return { round, from, events };
}

/**
 * Append this round's banners to a player's pending queue.
 *
 * Returns the *same array* when a round produced none, for the same reason
 * `appendLog` does: most rounds produce none at all, and an unchanged reference
 * keeps a subscribed component from re-rendering for news that did not happen.
 */
function queueReports(
  pending: BattleReport[],
  events: readonly VisibleEvent[],
  player: PlayerId,
  ownUnits: readonly Unit[],
  round: number,
): BattleReport[] {
  const fresh = battleReports(events, player, ownUnits, round);
  if (fresh.length === 0) return pending;
  return [...pending, ...fresh];
}

/**
 * Returns the *same array* when a player saw nothing this round, so a component
 * subscribed to one player's log does not re-render for a round that told them
 * nothing. Both players' logs are rebuilt on every update, and an unchanged
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
  authority = null;

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
    reports: { p1: [], p2: [] },
    replay: { p1: null, p2: null },
    finalReveal: null,
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
 * side: create the authority and hand it every human seat's finished setup.
 *
 * The authority invents any CPU seat's setup itself, **at this moment** — not
 * when the map was rolled — which is what keeps "the setup screen cannot leak the
 * opponent's placements" structural against a CPU (gotcha 43). In hotseat the
 * first player's hexes genuinely are in the store while the second places, so
 * that guarantee is carried by the handoff blank and the viewer-keyed hooks.
 *
 * The authority's `startMatch` re-validates every setup and throws on an illegal
 * one (§12), so a human's placements are held to exactly the rules the highlight
 * offered them. Its opening update arrives synchronously, through `receive`,
 * before this returns.
 */
function beginMatch(): void {
  const { seed, map, seats, placed, difficulty } = matchStore.getState();
  authority = createLocalAuthority({ map, seed, seats, difficulty }, receive);
  for (const player of humanSeats(seats)) {
    authority.submitSetup(player, placementSetup(placed[player]));
  }
  authority.advance(); // a no-op unless no seat is human (see `advance`)
}

/**
 * Choose which of your three assets you are positioning (spec §12).
 *
 * Any slot, at any time — placement order is free, so this is the whole input
 * the setup screen needs beyond the board itself. Selecting a slot that is
 * already placed selects its hex too, so the board shows you which asset you
 * have picked up.
 */
export function selectSlot(slotId: number): void {
  if (matchStarted()) return;

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
 * player who does not care about order simply click through the roster. When none is
 * empty it stays put, so the last asset placed is the one a further click moves.
 *
 * **This does NOT start the match**, and that is a deliberate reversal of how it
 * worked when placement was a fixed sequence. Back then the fourth click was
 * unambiguously "I am done". Now that any asset can be repositioned at any time,
 * auto-starting on the last placement would snatch the board away at exactly
 * the moment the player finally has the whole thing in front of them to judge.
 * `startPlacedMatch` is the explicit commitment instead.
 */
export function placeHex(hex: Hex): void {
  if (matchStarted()) return; // placement is over

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
  if (matchStarted()) return;
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
  if (matchStarted()) return;
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
 * until all are down, so reaching here early is a UI event, not a caller
 * bug — the same reasoning as `resolveRound` on a finished match.
 */
export function startPlacedMatch(): void {
  if (matchStarted()) return;

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

  beginMatch();
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
  if (matchStarted()) return;

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
  beginMatch();
}

/**
 * Whether the match is running and not yet over — the guard every turn action
 * shares. Both views carry the same phase, so any one of them answers it.
 */
function inPlay(): boolean {
  const view = Object.values(matchStore.getState().views ?? {})[0];
  return view !== undefined && view.phase !== 'GAME_OVER';
}

/**
 * Submit every human seat's drafted orders, which resolves the round.
 *
 * Undecided units simply contribute nothing, which is a perfectly legal round — a
 * launcher with no order holds and a drone with no order hovers (§3) — so this
 * is safe to call at any point in the order phase, with a full draft or an empty
 * one. The authority answers any CPU seat itself, from that seat's own redacted
 * view and history, and resolves once the last human seat is in; its update
 * arrives through `receive` before this returns, which also clears the drafts
 * and opens the next round.
 *
 * One call covers both kinds of round: the engine reads the phase and runs a
 * normal round or the dead-hand volley accordingly (§5), so this function does
 * not know the difference and must not learn it.
 *
 * A finished match is a no-op rather than a throw: a button pressed twice is a
 * UI event, not a caller bug.
 */
export function resolveRound(): void {
  if (!authority || !inPlay()) return;

  const { seats, draft } = matchStore.getState();
  for (const player of humanSeats(seats)) {
    authority.submitOrders(player, draftOrders(draft[player]));
  }
  authority.advance(); // a no-op unless no seat is human (see `advance`)
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
  if (!inPlay()) return;

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
 * Deliberately the `activeSeat`'s view and NOT the current `viewer`'s (gotcha
 * 55; step 10a used `SANDBOX_PLAYER`, the hotseat handoff made it the seat).
 * The viewer switch is a debug control, so flipping it to look at the CPU's
 * picture must not turn the order builder into a way to order the CPU's units.
 * Because a `VisibleGameState` holds only its owner's units (spec §6), an order naming any
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
 * **Capitulation is not a fact about the board** (spec §4), so the engine never
 * emits it: the authority sets it, and sends it back as an ordinary filtered
 * `GAME_OVER` update. A resigned match therefore ends with the same log entry and
 * the same terminal state as one the engine ended, and `receive` lifts any
 * pending handoff, because the result is public and both players may look at it.
 */
export function resign(player: PlayerId): void {
  authority?.resign(player);
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

/**
 * Choose how the CPU plays — **before the match only.**
 *
 * Refused once a match exists: the CPU's hidden setup is built from the
 * difficulty at match start (`./authority`), so a mid-match change would leave a
 * HARD player defending an EASY board. It is a choice about what game to play,
 * made on the setup screen like the seating (designer's call, 2026-09-28).
 */
export function setDifficulty(difficulty: CpuDifficulty): void {
  if (matchStarted()) return;
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
  // During a replay a click skips it (presentation phase, session 1): the board
  // on screen is last round's, so a click cannot mean an order or a selection.
  const { replay, viewer } = matchStore.getState();
  if (replay[viewer]) {
    finishReplay();
    return;
  }

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

/** `player`'s undismissed battle-report banners (V1.1 step 1). */
export function reportsFor(player: PlayerId): readonly BattleReport[] {
  return matchStore.getState().reports[player];
}

/**
 * Clear the banner at the head of the **viewer's** queue (V1.1 step 1).
 *
 * Keyed on `viewer` rather than taking a `PlayerId`, for gotcha 36's reason: a
 * dismiss that could name a player would be a way for whoever is at the machine
 * to clear their opponent's unread news — and in hotseat the opponent's banners
 * are queued precisely because they are not here yet to read them.
 *
 * One at a time, because a round can produce several (three launcher kills and a
 * `GAME_OVER` is a legal round) and they are worth reading individually.
 */
export function dismissReport(): void {
  const { reports, viewer } = matchStore.getState();
  const queue = reports[viewer];
  if (queue.length === 0) return;

  matchStore.setState({
    reports: { ...reports, [viewer]: queue.slice(1) },
  });
}

/** `player`'s pending replay, or null (presentation phase, session 1). */
export function replayFor(player: PlayerId): Replay | null {
  return matchStore.getState().replay[player];
}

/**
 * The **viewer's** replay is over — it played to the end or was skipped
 * (presentation phase, session 1). The board settles on the current view.
 *
 * Keyed on `viewer` and taking no `PlayerId`, for gotcha 36/57's reason: in
 * hotseat the other seat's replay is waiting for a player who has not sat down
 * yet, and nothing the person at the machine does may consume it.
 */
export function finishReplay(): void {
  const { replay, viewer } = matchStore.getState();
  if (replay[viewer] === null) return;

  matchStore.setState({ replay: { ...replay, [viewer]: null } });
}
