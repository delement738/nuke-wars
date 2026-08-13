// CLIENT STATE — not simulation code, and deliberately not in `src/sim/`.
//
// **Belief: turning a `VisibleGameState` back into a `GameState` the real sim
// validators will accept.**
//
// The problem this solves is the one build-order step 9 flagged as "the first
// real problem step 10 must solve, not a detail" (CLAUDE.md): every order
// validator in the sim — `reachableHexes`, `validateMove`, `validateLaunch`,
// `validateFly` — takes a full `GameState`, and no client ever holds one. The
// client holds a `VisibleGameState`, which by design has no enemy units in it at
// all (spec §6, gotcha 31).
//
// So the client builds a board *as it believes it to be*: its own units, the
// public map, and nothing standing in for an enemy it cannot see. Every order it
// proposes is checked against that belief with the SAME functions `resolve()`
// trusts. Two consequences worth stating plainly, because they are the whole
// reason this file exists rather than a parallel set of client-side rules:
//
//   1. **The CPU and the human are checked by identical code.** `cpu.ts` and the
//      order builder both come through here, so the CPU is provably bound by
//      exactly the fog a human in its seat would face — not by a promise, by a
//      shared import.
//   2. **An order that validates against belief can still fail for real.** If
//      truth disagrees — an unseen launcher parked on the hex you drove at — the
//      move fails entirely and the unit holds (spec §9, `MOVE_FAILED`). That is
//      the intended risk, not a bug to route around: advancing into unscouted
//      ground has to cost something, and that cost is what makes flying the
//      drone worth a round.
//
// Extracted from `cpu.ts` in build-order step 10a. The rejected alternative was
// narrowing the sim validators to take `(units, map)` instead of a whole
// `GameState` — architecturally tidier, but it touches three sim modules plus
// their tests, so it stays available as its own housekeeping session later.

import { hexKey } from '../sim/hex';
import type { GameState, PlayerIntel, VisibleGameState } from '../sim/types';

/** Never read by `reachableHexes`/`validateMove`/`validateLaunch`/`validateFly`
 * — they touch only `units` and `map` — but `GameState` requires the field. */
const EMPTY_INTEL: PlayerIntel = { staticReveals: [], contacts: [] };

/**
 * The board as `view`'s owner believes it to be: their own units, the public
 * map, and **nothing standing in for the enemy**.
 *
 * The absence is the point. Filling in guessed enemy positions from `intel`
 * would make the validators reject moves onto hexes the player is entitled to
 * *try* — and, worse, would let the UI's legality highlight double as a
 * detector. Known enemy hexes are handled separately and for movement only; see
 * `knownEnemyHexes`.
 */
export function believedState(view: VisibleGameState): GameState {
  return {
    round: view.round,
    phase: view.phase,
    map: view.map,
    units: view.units,
    intel: { p1: EMPTY_INTEL, p2: EMPTY_INTEL },
    droneRespawnIn: { p1: 0, p2: 0 },
    deadHandFor: view.deadHandFor,
    outcome: view.outcome,
  };
}

/** Hexes this player already believes hold an enemy asset (spec §11 intel) —
 * never a legal MOVE destination, even though `believedState` has no unit
 * there to reject it with `TILE_OCCUPIED`. Firing AT one of these is exactly
 * the point; this set is consulted for movement only. */
export function knownEnemyHexes(view: VisibleGameState): Set<string> {
  const known = new Set<string>();
  for (const reveal of view.intel.staticReveals) known.add(hexKey(reveal.hex));
  for (const contact of view.intel.contacts) known.add(hexKey(contact.hex));
  return known;
}
