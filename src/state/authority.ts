// CLIENT STATE — the match authority (V1.5 Session 5, the authority split).
//
// **This is the only module in the client that holds an unfiltered `GameState`.**
// It owns the match: it takes each seat's setup and orders, runs `startMatch` and
// `resolve()`, plays any CPU seat itself, and hands each player back exactly one
// thing — a `MatchUpdate`, built from `filterForPlayer` / `filterEventsForPlayer`
// and nothing else. The store in `./match` is the other half: it drafts, draws
// and passes the screen, and it never holds the truth at all.
//
// The split is the shape of V1.5's server. `MatchAuthority` is the whole contract
// between "who resolves the match" and "who draws it": three calls in (setup,
// orders, resign) and one callback out (updates). `createLocalAuthority` fills it
// in-process for solo and hotseat; Session 6 fills it with a WebSocket to a
// server that runs this same code, and the store does not change.
//
// Why the truth is safe here (gotchas 34, 35): `truth` is a closure variable of
// one authority instance. Nothing returns it, nothing stores it, and the only
// object the store ever receives is a `MatchUpdate`. The one piece of truth an
// update may carry is the end-of-match reveal, and only at `GAME_OVER` (gotcha 73).
//
// Layering: client state, so it may import `src/sim/`; no React, no store.

import { makeRng, type MapData } from '../sim/map';
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
  type Unit,
  type VisibleEvent,
  type VisibleGameState,
} from '../sim/types';
import { filterEventsForPlayer, filterForPlayer } from '../sim/visibility';
import { cpuOrders, type CpuDifficulty } from './cpu';
import { cpuSetup } from './cpuSetup';
import { humanSeats, type Seating } from './seats';

/**
 * Everything one player is told when the match changes — the only thing that
 * ever crosses from the authority to a client (spec §6 layer 2).
 *
 * The same shape serves all three moments: the match starting (`events` empty),
 * a round resolving, and a resignation. That is what lets the store handle them
 * with one code path, and what Session 6 sends down the wire.
 */
export interface MatchUpdate {
  /**
   * The round these events belong to — the one that was *resolved*, not the one
   * the state moved on to, so a launch detected in round 4 reads as round 4
   * forever after (see `LogEntry`). On the opening update it is round 1.
   */
  round: number;
  /** The board as this player may see it now. */
  view: VisibleGameState;
  /** This player's filtered slice of what just happened, in engine order. */
  events: readonly VisibleEvent[];
  /**
   * The opponent's real pieces — **null for the whole match and set only once the
   * phase is GAME_OVER** (gotcha 73). Straight from the truth, decoy included.
   */
  finalReveal: readonly Unit[] | null;
}

/**
 * One delivery of updates, keyed by the player each is for.
 *
 * Partial on purpose. The local authority sends both seats at once, because one
 * screen holds both players' views in hotseat and solo keeps the CPU's for the
 * debug viewer. A network client will only ever receive its own seat's.
 */
export type MatchUpdates = Partial<Record<PlayerId, MatchUpdate>>;

/**
 * Who resolves the match. Three calls in, and `MatchUpdates` out through the
 * listener the authority was created with.
 *
 * Every call is **per seat**, which is what a network needs: each client speaks
 * only for its own player. A submission that arrives at the wrong time (a setup
 * after the match started, orders after it ended, a seat the authority plays
 * itself) is ignored rather than thrown — it is an event from outside, not a
 * programming error, the same reasoning the store uses for a double-pressed
 * button.
 */
export interface MatchAuthority {
  /**
   * This seat's secret setup (spec §12). The match starts once every seat has
   * one; `startMatch` re-validates them all and throws on an illegal one.
   */
  submitSetup(player: PlayerId, setup: PlayerSetup): void;
  /**
   * This seat's orders for the current round (spec §3). The round resolves once
   * every seat has submitted; until then nothing happens, which is what keeps
   * orders simultaneous.
   */
  submitOrders(player: PlayerId, orders: readonly Order[]): void;
  /** This seat capitulates (spec §4). Ends the match at once. */
  resign(player: PlayerId): void;
}

/**
 * The in-process authority, which can do one thing a remote one never will:
 * drive a match that has no human seat at all.
 */
export interface LocalAuthority extends MatchAuthority {
  /**
   * Move the match on if no seat is still owed: start it once every seat has a
   * setup, or resolve the round once every seat has orders. With a human seat
   * the submissions already did this and it is a no-op; with none (CPU against
   * CPU, in tests and soaks) nothing is ever submitted, so this is the only way
   * the match advances.
   */
  advance(): void;
}

/** What a local match is: the board, the seed and who sits where. */
export interface LocalMatchConfig {
  map: MapData;
  seed: number;
  seats: Seating;
  /** How any `'cpu'` seat plays. Fixed for the match (designer's call, 2026-09-28). */
  difficulty: CpuDifficulty;
}

/**
 * Which stream a setup is drawn from, per player (build-order step 10b).
 *
 * Per player rather than one shared stream, for two reasons. It must not be two
 * streams from one *seed* — that would make each side's setup a deterministic
 * function of the other's (see `sandboxSetup`) — and keying on the player rather
 * than on call order means the CPU's board at a given seed is the same whether
 * or not the human pressed Auto-place, which is what "same seed, same match"
 * has to mean to be worth anything.
 *
 * The offset keeps this clear of the round stream (`seed * 100000 + round`),
 * which runs to `RULES.roundCap`. Exported because the store's Auto-place draws a
 * human's setup from the same stream.
 */
const SETUP_RNG_OFFSET = 90000;

export function setupRng(seed: number, player: PlayerId): () => number {
  return makeRng(seed * 100000 + SETUP_RNG_OFFSET + PLAYERS.indexOf(player));
}

/**
 * The in-process authority for solo and hotseat play.
 *
 * It answers every `'cpu'` seat itself and waits for every `'human'` one, so the
 * store asks each human seat the same question a server will: *what are your
 * orders?* Updates are delivered **synchronously**, inside the call that caused
 * them, which is why a store action that submits the last orders can read the
 * new board on its next line.
 */
export function createLocalAuthority(
  config: LocalMatchConfig,
  onUpdate: (updates: MatchUpdates) => void,
): LocalAuthority {
  const { map, seed, seats, difficulty } = config;
  const humans = humanSeats(seats);

  /** Null until every seat has set up — there is no board to hold before then. */
  let truth: GameState | null = null;
  const setups: Partial<Record<PlayerId, PlayerSetup>> = {};
  let pending: Partial<Record<PlayerId, readonly Order[]>> = {};

  /**
   * Each CPU seat's memory: its own filtered history, the same events a human in
   * that seat would have in their log — so the CPU remembers only what a human
   * could (gotcha 34's discipline applied to the opponent).
   */
  const history: Record<PlayerId, readonly VisibleEvent[]> = { p1: [], p2: [] };

  /**
   * Tell every player what just happened. Every event a client ever sees passes
   * through here, including the one `resign` synthesises: nothing skips the
   * filter because it was "obviously public".
   */
  function publish(state: GameState, round: number, events: readonly GameEvent[]): void {
    const updates: MatchUpdates = {};
    for (const player of PLAYERS) {
      const seen = filterEventsForPlayer(events, player);
      history[player] = [...history[player], ...seen];
      updates[player] = {
        round,
        view: filterForPlayer(state, player),
        events: seen,
        finalReveal:
          state.phase === 'GAME_OVER'
            ? state.units.filter((unit) => unit.owner === opponentOf(player))
            : null,
      };
    }
    onUpdate(updates);
  }

  /** Whether `player` is a seat the authority waits on rather than answers. */
  function isHuman(player: PlayerId): boolean {
    return seats[player] === 'human';
  }

  /**
   * The `SETUP -> ORDER_PHASE` edge (spec §5, §12). A CPU seat's setup is
   * invented **here, at match start**, never earlier, so no enemy setup exists
   * anywhere while a human is still placing (gotcha 43).
   */
  function begin(): void {
    const all: Record<PlayerId, PlayerSetup> = { p1: [], p2: [] };
    for (const player of PLAYERS) {
      // `cpuSetup`, not `sandboxSetup`: HARD places its base deliberately. The
      // human's Auto-place stays on the plain fixture (see the store's `autoPlace`).
      all[player] = isHuman(player)
        ? setups[player]!
        : cpuSetup(map, player, difficulty, setupRng(seed, player));
    }
    const state = startMatch(map, all);
    truth = state;
    publish(state, state.round, []);
  }

  /**
   * Resolve one round from every seat's orders (spec §3).
   *
   * The CPU is handed `filterForPlayer(truth, player)`, never `truth` — the same
   * redacted view a human in that seat gets — and a `rng` derived from the seed
   * and round, so a match at a fixed seed and difficulty always plays out the
   * same. One call covers the dead-hand round too: `resolve` and `cpuOrders`
   * both read the phase themselves (§5).
   */
  function resolveRound(state: GameState): void {
    // Stamped before resolving: `resolve` hands back the *next* round's number.
    const round = state.round;

    const submitted: Record<PlayerId, readonly Order[]> = { p1: [], p2: [] };
    for (const player of PLAYERS) {
      submitted[player] = isHuman(player)
        ? pending[player]!
        : cpuOrders(
            filterForPlayer(state, player),
            difficulty,
            player,
            makeRng(seed * 100000 + round),
            history[player],
          );
    }
    pending = {};

    const result = resolve(state, submitted.p1, submitted.p2, seed);
    truth = result.state;
    publish(result.state, round, result.events);
  }

  /** Start or resolve if every human seat has handed over what it owes. */
  function advance(): void {
    if (!truth) {
      if (humans.every((seat) => setups[seat])) begin();
    } else if (truth.phase !== 'GAME_OVER') {
      if (humans.every((seat) => pending[seat])) resolveRound(truth);
    }
  }

  return {
    advance,

    submitSetup(player, setup) {
      if (truth || !isHuman(player)) return;
      setups[player] = setup;
      advance();
    },

    submitOrders(player, orders) {
      if (!truth || truth.phase === 'GAME_OVER' || !isHuman(player)) return;
      pending[player] = orders;
      advance();
    },

    // Capitulation is not a fact about the board (spec §4): no arrangement of
    // units implies it, so the engine never emits it. Whatever owns the match
    // sets it, which is why this is the one change to `truth` made without
    // `resolve`. It still goes out as a filtered GAME_OVER event, so a resigned
    // match ends with the same log entry and terminal state as any other.
    resign(player) {
      if (!truth || truth.phase === 'GAME_OVER') return;
      const outcome: Outcome = { type: 'CAPITULATION', winner: opponentOf(player) };
      truth = { ...truth, phase: 'GAME_OVER', outcome };
      pending = {};
      publish(truth, truth.round, [{ type: 'GAME_OVER', outcome }]);
    },
  };
}
