// CLIENT STATE — who is behind each player's orders (build-order step 10c).
//
// Same discipline as `./orders` and `./placement`: a plain, testable module with
// no React and no store access, answering the questions the handoff needs —
// *who is a human*, *who takes the screen first*, and *who takes it next*.
//
// **This is the module that replaced the hardcoded "p1 is the human".** Until
// 10c the store assumed one human seat and one CPU seat, and `resolveRound`
// branched on that assumption in one place while `orderingView` restated it in
// another. Modelling the seats instead of the mode removes the branch: every
// seat is asked the same question — *what are this player's orders?* — and the
// two answers differ only in where they come from.
//
// Nothing here knows about secrecy. The handoff *screen* is what keeps one
// player from seeing another's board; this module only decides whose turn it is.

import { PLAYERS, type PlayerId } from '../sim/types';

/**
 * Who supplies a player's orders.
 *
 * Deliberately a property of each **seat** rather than a mode for the match. A
 * `mode: 'SOLO' | 'HOTSEAT'` flag would be a single fact that every consumer has
 * to re-interpret ("in solo, which one is the human?"), and the answer would be
 * written down in several places. A seating says it once.
 */
export type SeatKind = 'human' | 'cpu';

/** Who fills both seats. */
export type Seating = Readonly<Record<PlayerId, SeatKind>>;

/** One human against the CPU — the client's default, and step 9's arrangement. */
export const SOLO_SEATS: Seating = { p1: 'human', p2: 'cpu' };

/** Two humans passing one screen (build-order step 10c). */
export const HOTSEAT_SEATS: Seating = { p1: 'human', p2: 'human' };

/**
 * The human seats, in `PLAYERS` order.
 *
 * The order is the turn order, and it comes from `PLAYERS` rather than from a
 * list here so the handoff visits seats in the same sequence the engine
 * iterates them (spec §6's determinism discipline: one iteration order, defined
 * once). Orders are simultaneous, so this sequence is presentation only — it
 * decides who *drafts* first, never who *acts* first.
 */
export function humanSeats(seats: Seating): PlayerId[] {
  return PLAYERS.filter((player) => seats[player] === 'human');
}

/** Whether this seating needs a pass-the-screen handoff at all. */
export function isHotseat(seats: Seating): boolean {
  return humanSeats(seats).length > 1;
}

/**
 * The first human seat with something to do, or null if none has.
 *
 * `hasWork` is what makes the dead-hand round come out right. Only the player
 * facing the dead hand has orderable units (§3), and handing the screen to
 * someone with nothing to decide would strand the round: their draft can never
 * complete, because "every one of zero units is decided" is deliberately false
 * (gotcha 41c). Skipping them is that same guard, one level up.
 *
 * Null means "no human has anything to decide" — which is the cue to resolve,
 * not an error. It happens on a finished match and on a dead-hand round in solo
 * play where the CPU is the one firing.
 */
export function openingSeat(
  seats: Seating,
  hasWork: (player: PlayerId) => boolean,
): PlayerId | null {
  return humanSeats(seats).find(hasWork) ?? null;
}

/**
 * The next human seat after `from` with something to do, or null when `from` was
 * the last — which is the cue to resolve the round.
 *
 * It does **not** wrap. The sequence is one pass over the human seats per round,
 * so reaching the end means everyone has drafted, not that it is p1's turn
 * again.
 */
export function nextSeat(
  seats: Seating,
  from: PlayerId,
  hasWork: (player: PlayerId) => boolean,
): PlayerId | null {
  const humans = humanSeats(seats);
  return humans.slice(humans.indexOf(from) + 1).find(hasWork) ?? null;
}
