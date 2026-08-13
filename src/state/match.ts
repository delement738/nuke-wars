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

import type { Hex } from '../sim/hex';
import { generateMap, makeRng } from '../sim/map';
import { resolve } from '../sim/resolve';
import { startMatch, type PlayerSetup } from '../sim/setup';
import {
  opponentOf,
  type GameEvent,
  type GameState,
  type Order,
  type Outcome,
  type PlayerId,
  type VisibleEvent,
  type VisibleGameState,
} from '../sim/types';
import { filterEventsForPlayer, filterForPlayer } from '../sim/visibility';
import { createStore } from 'zustand/vanilla';
import { cpuOrders, type CpuDifficulty } from './cpu';
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
  /** How the CPU (`SANDBOX_DUMMY`) plays. A sandbox control, same as `viewer`. */
  difficulty: CpuDifficulty;
  /** Whose redacted view is on screen. A sandbox control; step 10's handoff owns it. */
  viewer: PlayerId;
  /** The hex the player clicked, or null. Presentation state, not game state. */
  selected: Hex | null;
  /** Both players' redacted boards, rebuilt from `truth` after every change. */
  views: Record<PlayerId, VisibleGameState>;
  /** Both players' permanent event histories, filtered on the way in. */
  logs: Record<PlayerId, LogEntry[]>;
}

// ---------------------------------------------------------------------------
// The truth (module-private — see the header)
// ---------------------------------------------------------------------------

function freshTruth(seed: number): GameState {
  // Width and height are left at their defaults: board size is a spec §7 number
  // that belongs to the sim, and repeating it here would be a second place for
  // it to be wrong.
  const map = generateMap(undefined, undefined, seed);

  const setups: Record<PlayerId, PlayerSetup> = {
    p1: sandboxSetup(map, 'p1'),
    p2: sandboxSetup(map, 'p2'),
  };

  // The SETUP -> ORDER_PHASE edge of §5's state machine. `startMatch` re-checks
  // both setups and throws on an illegal one, so the sandbox fixture is held to
  // exactly the rules step 10's UI will be.
  return startMatch(map, setups);
}

let truth: GameState = freshTruth(DEFAULT_SEED);

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
  difficulty: DEFAULT_DIFFICULTY,
  viewer: SANDBOX_PLAYER,
  selected: null,
  views: viewsOf(truth),
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

/** Start a fresh sandbox match on a new map. Clears both logs and the selection. */
export function newMatch(seed: number = DEFAULT_SEED): void {
  truth = freshTruth(seed);
  matchStore.setState({
    seed,
    viewer: SANDBOX_PLAYER,
    selected: null,
    views: viewsOf(truth),
    logs: { p1: [], p2: [] },
  });
}

/**
 * Resolve one round: the human's orders against the CPU's (spec §8 step 9's
 * seam; step 9 shipped the CPU side as `[]`, unconditionally — `src/state/cpu.ts`
 * fills it in).
 *
 * `orders` defaults to none because there is still no order builder for the
 * human side — that is step 10 — and a launcher with no order holds while a
 * drone with no order hovers (§3), which is a perfectly legal round. The
 * parameter exists so step 10 plugs a real order list into this seam rather
 * than rewriting the round loop.
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
export function resolveRound(orders: readonly Order[] = []): void {
  if (truth.phase === 'GAME_OVER') return;

  // Stamped before resolving: `resolve` hands back the *next* round's number
  // (and freezes it on game over), while these events belong to the round that
  // was just played.
  const round = truth.round;

  const { seed, difficulty } = matchStore.getState();
  const cpuView = filterForPlayer(truth, SANDBOX_DUMMY);
  const cpuRng = makeRng(seed * 100000 + round);

  const submitted: Record<PlayerId, readonly Order[]> = {
    p1: [],
    p2: [],
  };
  submitted[SANDBOX_PLAYER] = orders;
  submitted[SANDBOX_DUMMY] = cpuOrders(cpuView, difficulty, SANDBOX_DUMMY, cpuRng);

  const result = resolve(
    truth,
    submitted.p1,
    submitted.p2,
    matchStore.getState().seed,
  );
  truth = result.state;

  publish(round, result.events);
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
  if (truth.phase === 'GAME_OVER') return;

  const outcome: Outcome = { type: 'CAPITULATION', winner: opponentOf(player) };
  truth = { ...truth, phase: 'GAME_OVER', outcome };
  publish(truth.round, [{ type: 'GAME_OVER', outcome }]);
}

/** Switch which player's redacted view is rendered (a sandbox control). */
export function setViewer(viewer: PlayerId): void {
  matchStore.setState({ viewer, selected: null });
}

/** Change how the CPU plays, effective from the next `resolveRound()` call. */
export function setDifficulty(difficulty: CpuDifficulty): void {
  matchStore.setState({ difficulty });
}

/** Select a hex, or clear the selection with null. */
export function selectHex(hex: Hex | null): void {
  matchStore.setState({ selected: hex });
}

// ---------------------------------------------------------------------------
// Reads — for tests and for the hooks in ./useMatch
// ---------------------------------------------------------------------------

/** What `player` is allowed to see of the board right now. */
export function viewFor(player: PlayerId): VisibleGameState {
  return matchStore.getState().views[player];
}

/** `player`'s permanent history — every event they were allowed to see (§11). */
export function logFor(player: PlayerId): readonly LogEntry[] {
  return matchStore.getState().logs[player];
}
