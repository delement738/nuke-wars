// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// Outcomes and the dead-hand trigger — resolution phase 4 (spec §3, §4, §5;
// build-order step 7). Same split as every other module in this directory: this
// file answers one question — "is the match over, and how?" — and resolve() acts
// on the answer by skipping phases, emitting events and moving the state machine.
//
// Four rules shape everything here:
//   - **Bunker outcomes outrank launcher outcomes** (§4). A player who loses
//     their last launcher in the same resolution that destroys the enemy bunker
//     still wins by decapitation, subject to dead hand — so the bunker branch is
//     resolved to completion before the launcher counts are even read.
//   - **The decoy is never an outcome** (§4, §12). Only `kind === 'bunker'` is
//     tested anywhere below. Destroying a decoy triggers no dead hand, satisfies
//     no win condition, and must not appear in this file at all.
//   - **Absence is not destruction.** A side with no bunker *unit* is not
//     decapitated and a side with no launcher *units* is not disarmed — only
//     units that exist and are flagged destroyed count. In a real match this
//     changes nothing (everyone starts with 1 bunker and 3 launchers, and
//     `startMatch` guarantees it), but it keeps the engine inert on the partial
//     boards the tests are built from, and it is the honest reading: you lose by
//     having your launchers destroyed, not by never having had any.
//   - **Victory is evaluated once, after a full resolution** (§5), never
//     mid-round. That is why this is a single function over a finished board
//     rather than a check sprinkled through the phases.

import { RULES } from './defs';
import {
  PLAYERS,
  opponentOf,
  type GameState,
  type Outcome,
  type PlayerId,
  type Unit,
} from './types';

/**
 * What phase 4 decided (spec §3, §4).
 *
 * Three cases, because "the bunker died" is not an outcome on its own: it hands
 * the decapitated player one final round (spec §3) and only *then* adjudicates.
 * Keeping DEAD_HAND separate from OUTCOME is what stops resolve() having to
 * infer the difference from an outcome-shaped value.
 */
export type Adjudication =
  /** The match continues — run phase 5 and hand over to the next order phase. */
  | { type: 'CONTINUE' }
  /** `player`'s real bunker just died; they get the final retaliation round. */
  | { type: 'DEAD_HAND'; player: PlayerId }
  /** The match is over. */
  | { type: 'OUTCOME'; outcome: Outcome };

/** Every launcher a player owns, destroyed ones included. */
function launchersOf(units: readonly Unit[], player: PlayerId): Unit[] {
  return units.filter((u) => u.kind === 'launcher' && u.owner === player);
}

/**
 * A player's surviving launchers — their entire offensive capability (§1).
 *
 * Exported because the dead-hand trigger asks it too: a decapitated player with
 * nothing left to fire has no final round to play (§3, ruled in step 7).
 */
export function livingLaunchers(
  units: readonly Unit[],
  player: PlayerId,
): Unit[] {
  return launchersOf(units, player).filter((u) => !u.destroyed);
}

/**
 * Whether this player's REAL bunker has been destroyed (§4).
 *
 * `kind === 'bunker'` and nothing else. The decoy is deliberately invisible to
 * this function: destroying it wins nothing and triggers nothing (§12), and the
 * silence where a dead hand would have been is exactly what tells the attacker
 * they hit the fake.
 *
 * Munitions being unlimited, the bunker is the only asset whose destruction is
 * ever "just happened" rather than "has been true for a while" — a match with a
 * destroyed bunker ends in the same resolution, so this can never report a kill
 * from an earlier round on a live board.
 */
function bunkerDestroyed(units: readonly Unit[], player: PlayerId): boolean {
  return units.some(
    (u) => u.kind === 'bunker' && u.owner === player && u.destroyed,
  );
}

/**
 * Whether this player has lost every launcher they ever had (§4 row 5).
 *
 * The `length > 0` guard is the "absence is not destruction" rule from the
 * header: a board with no launchers on it at all — every test fixture that only
 * cares about drones, say — is not a disarmament, it is a board with no
 * launchers on it.
 */
function isDisarmed(units: readonly Unit[], player: PlayerId): boolean {
  const all = launchersOf(units, player);
  return all.length > 0 && all.every((u) => u.destroyed);
}

/**
 * Resolution phase 4 — evaluate spec §4's table, in priority order, against a
 * finished board.
 *
 * Reads `state.phase` to know which round it is adjudicating, which is what lets
 * one function serve both: in a normal round a single destroyed bunker means the
 * loser gets their final volley, while in the dead-hand round that same board
 * means the match is over. The state machine's current node decides, so neither
 * caller has to pass a flag that could be passed wrongly.
 *
 * **CAPITULATION is never returned.** Resigning is not a fact about the board —
 * no combination of units can imply it — so it is set by whatever owns the match
 * (the store, build-order step 9) rather than derived here. It stays in the
 * `Outcome` union because §4 lists it and a game-over screen must render it.
 *
 * Deterministic and side-effect free: it reads units, the round number and the
 * phase, and returns a verdict. It emits nothing and mutates nothing.
 */
export function adjudicate(state: GameState): Adjudication {
  const finalRound = state.phase === 'DEAD_HAND_PHASE';
  const decapitated = PLAYERS.filter((p) => bunkerDestroyed(state.units, p));

  // §4 row 1. Both bunkers gone is a draw however it happened — the same impact
  // phase, or a dead-hand missile answering the strike that started it. §3's
  // "if both real bunkers die in the same impact phase, skip dead hand" is this
  // branch sitting above the trigger below, not a separate rule.
  if (decapitated.length === 2) {
    return { type: 'OUTCOME', outcome: { type: 'MUTUAL_ANNIHILATION' } };
  }

  if (decapitated.length === 1) {
    const [loser] = decapitated;

    // §3's final round, and the one case where a destroyed bunker is not yet an
    // outcome. It is skipped when there is nothing left to fire with: "every
    // surviving launcher may fire one missile" is a round that cannot exist with
    // zero launchers, it could not change this verdict, and in hotseat it would
    // be a pass-the-screen handoff to confirm an empty order phase. Ruled in
    // build-order step 7; spec §3 amended to match.
    if (!finalRound && livingLaunchers(state.units, loser).length > 0) {
      return { type: 'DEAD_HAND', player: loser };
    }

    // §4 row 2 — and note what is NOT consulted: the winner's launcher count.
    // Bunker outcomes outrank launcher outcomes (§4), so a player who spent
    // their last launcher on the killing shot still wins by decapitation.
    return {
      type: 'OUTCOME',
      outcome: { type: 'DECAPITATION', winner: opponentOf(loser) },
    };
  }

  // §4 rows 4 and 5. Both are read off the current board rather than from what
  // happened this round: a player with zero launchers has zero offensive
  // capability and loses immediately (§1), so the game can never continue into a
  // later round with one still standing at zero. "In the same round" in §4's
  // wording is therefore descriptive, not an extra condition to test.
  const disarmed = PLAYERS.filter((p) => isDisarmed(state.units, p));
  if (disarmed.length === 2) {
    return { type: 'OUTCOME', outcome: { type: 'MUTUAL_DISARMAMENT' } };
  }
  if (disarmed.length === 1) {
    return {
      type: 'OUTCOME',
      outcome: { type: 'DISARMAMENT', winner: opponentOf(disarmed[0]) },
    };
  }

  // §4 row 6, checked last because it is the lowest priority: a victory landing
  // on the final round is still a victory. `state.round` is the round being
  // resolved, so reaching the cap means this resolution is the 25th and last.
  if (state.round >= RULES.roundCap) {
    return { type: 'OUTCOME', outcome: { type: 'ARMISTICE' } };
  }

  return { type: 'CONTINUE' };
}
