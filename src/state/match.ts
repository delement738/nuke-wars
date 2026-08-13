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
  placementComplete,
  withPlacement,
  withoutLastPlacement,
} from './placement';
import { sandboxSetup } from './sandbox';

/**
 * The side a human plays in the sandbox; the other is the CPU (spec §8 step 9
 * shipped it as a static dummy that never ordered anything — `src/state/cpu.ts`
 * replaced that with a real, difficulty-tiered opponent). Written as constants
 * rather than assumed to be p1 everywhere, so step 10's hotseat handoff
 * replaces two definitions instead of hunting literals.
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
   * The human's secret placements so far, in placement order (spec §12).
   *
   * Populated on the setup screen and left in place once the match starts, where
   * it is simply a record of where they put their own four assets — their own
   * knowledge, which they are always allowed to see (§11 rule 1). In session
   * 10c's hotseat this becomes one per player and gotcha 36's discipline applies
   * then: the inactive player must not see the other's.
   */
  placed: PlayerSetup;
  /** How the CPU (`SANDBOX_DUMMY`) plays. A sandbox control, same as `viewer`. */
  difficulty: CpuDifficulty;
  /** Whose redacted view is on screen. A sandbox control; step 10's handoff owns it. */
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
   * Orders the human has queued for `SANDBOX_PLAYER` this round, keyed by unit
   * so the §9 one-order-per-unit budget is structural (`./orders`).
   *
   * In sandbox this is not a secret — there is only one human at the screen, and
   * the CPU decides its own orders inside `resolveRound` from its own redacted
   * view. In session 10c's hotseat it becomes one, and gotcha 36's discipline
   * applies then: two drafts, and the inactive player must not see the other's.
   */
  draft: OrderDraft;
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
  placed: [],
  difficulty: DEFAULT_DIFFICULTY,
  viewer: SANDBOX_PLAYER,
  selected: null,
  selectedUnitId: null,
  hovered: null,
  draft: EMPTY_DRAFT,
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
  truth = null;
  matchStore.setState({
    seed,
    map: freshMap(seed),
    placed: [],
    viewer: SANDBOX_PLAYER,
    selected: null,
    selectedUnitId: null,
    hovered: null,
    draft: EMPTY_DRAFT,
    orderMode: null,
    views: null,
    logs: { p1: [], p2: [] },
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
function beginMatch(humanSetup: PlayerSetup): void {
  const { seed, map } = matchStore.getState();

  const setups: Record<PlayerId, PlayerSetup> = { p1: [], p2: [] };
  setups[SANDBOX_PLAYER] = humanSetup;
  setups[SANDBOX_DUMMY] = sandboxSetup(
    map,
    SANDBOX_DUMMY,
    setupRng(seed, SANDBOX_DUMMY),
  );

  truth = startMatch(map, setups);
  matchStore.setState({
    placed: humanSetup,
    views: viewsOf(truth),
    selected: null,
    selectedUnitId: null,
    hovered: null,
  });
}

/**
 * Place the current step's asset on `hex` (spec §12).
 *
 * An illegal hex is dropped rather than stored — `withPlacement` checks it
 * against the real §12 validator — so nothing downstream has to defend against a
 * setup containing one.
 *
 * **Completing the roster starts the match**, the same way a complete order
 * draft resolves the round (`resolveIfComplete`): the fourth placement is the
 * last decision the setup screen is waiting for, so there is nothing left to
 * press a button for. Unlike the order draft this needs no empty-set guard —
 * `placementComplete` counts placements against a fixed roster rather than
 * asking whether an empty set of things is all decided (contrast `allDecided`,
 * gotcha 41c).
 */
export function placeHex(hex: Hex): void {
  if (truth) return; // the match has started; placement is over

  const { map, placed } = matchStore.getState();
  const next = withPlacement(map, SANDBOX_PLAYER, placed, hex);
  if (next === placed) return; // illegal — the same reference means nothing moved

  if (placementComplete(next)) {
    beginMatch(next);
    return;
  }
  matchStore.setState({ placed: next, selected: hex });
}

/** Take back the most recent placement. Refused once the match has started —
 *  a setup is secret and final the moment the board is built (§12). */
export function undoPlacement(): void {
  if (truth) return;
  matchStore.setState({
    placed: withoutLastPlacement(matchStore.getState().placed),
    selected: null,
  });
}

/** Start the placement sequence over from the bunker, on the same board. */
export function clearPlacements(): void {
  if (truth) return;
  matchStore.setState({ placed: [], selected: null });
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
  const { seed, map } = matchStore.getState();
  beginMatch(sandboxSetup(map, SANDBOX_PLAYER, setupRng(seed, SANDBOX_PLAYER)));
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

  const { seed, difficulty, draft } = matchStore.getState();
  const cpuView = filterForPlayer(truth, SANDBOX_DUMMY);
  const cpuRng = makeRng(seed * 100000 + round);

  const submitted: Record<PlayerId, readonly Order[]> = {
    p1: [],
    p2: [],
  };
  submitted[SANDBOX_PLAYER] = draftOrders(draft);
  submitted[SANDBOX_DUMMY] = cpuOrders(cpuView, difficulty, SANDBOX_DUMMY, cpuRng);

  const result = resolve(truth, submitted.p1, submitted.p2, seed);
  truth = result.state;

  // The draft belongs to the round that has just been played. Clearing it here
  // rather than in the UI is what makes "orders are a one-round commitment"
  // (§3) hold no matter which path resolved the round — the button, or a
  // completed draft resolving itself.
  matchStore.setState({
    draft: EMPTY_DRAFT,
    orderMode: null,
    selected: null,
    selectedUnitId: null,
    hovered: null,
  });
  publish(round, result.events);
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
  return matchStore.getState().views?.[SANDBOX_PLAYER] ?? null;
}

/**
 * Resolve the round the moment every orderable unit has been decided.
 *
 * This is what makes the round fire on its own instead of waiting for a button.
 * It is called only from the two actions that *add* a decision, and it leans
 * entirely on `allDecided`'s empty-set guard — during the CPU's dead-hand round
 * the human has no orderable units, and "all zero of them are decided" would
 * otherwise be true forever (see the note in `./orders`).
 */
function resolveIfComplete(): void {
  const view = orderingView();
  if (view && allDecided(view, matchStore.getState().draft)) resolveRound();
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

  const draft = withOrder(view, matchStore.getState().draft, order);
  matchStore.setState({ draft, orderMode: null, hovered: null });
  resolveIfComplete();
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

  const draft = withHold(view, matchStore.getState().draft, unit);
  matchStore.setState({ draft, orderMode: null, hovered: null });
  resolveIfComplete();
}

/** Un-decide a unit. Never resolves the round — removing a decision cannot
 *  complete a draft, and a player undoing an order wants to keep ordering. */
export function clearOrder(unitId: UnitId): void {
  matchStore.setState({
    draft: withoutOrder(matchStore.getState().draft, unitId),
    orderMode: null,
  });
}

/** Discard every queued decision for this round. */
export function clearDraft(): void {
  matchStore.setState({ draft: EMPTY_DRAFT, orderMode: null });
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
  matchStore.setState({ draft: EMPTY_DRAFT, orderMode: null });
  publish(truth.round, [{ type: 'GAME_OVER', outcome }]);
}

/**
 * Switch which player's redacted view is rendered (a sandbox control).
 *
 * The selection is cleared because it means nothing on the other player's board;
 * the **draft is deliberately left alone**, so glancing at the CPU's picture and
 * coming back does not silently throw away the orders you had queued. Entry is
 * disabled while spectating instead (see `orderingView`).
 */
export function setViewer(viewer: PlayerId): void {
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
