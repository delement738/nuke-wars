// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// The visibility filter (spec §6 layer 2, §11, §12; build-order step 8).
//
// resolve() is an omniscient referee: it computes and emits the whole truth of
// every round, both players' positions included. This module hands each player
// a *redacted copy* of that truth. Two copies, two different redactions, one
// underlying state — which is the only arrangement that keeps the engine honest
// while the players stay blind.
//
// In hotseat it hides the inactive player's information across the handoff. In
// V1.5 the server runs it before broadcasting, so a client physically never
// receives the enemy's positions and cheating becomes impossible by
// construction rather than by policy. That is why both functions are pure, take
// no state they do not need, and live in `src/sim/` with the engine.
//
// **This is the single place in the codebase permitted to know a decoy is a
// decoy** (spec §6, §12). Everywhere else — resolve(), the intel it writes, the
// events it emits — stores and reports `kind: 'decoy'` truthfully. The mask is
// applied here, on the way out, and nowhere else. A lie the engine has to
// maintain internally is a bug waiting to happen; a lie applied once at the
// boundary is a redaction.
//
// Two structural notes, because they are what make this file short:
//
//   1. **It decides nothing.** resolve() already does every piece of intel
//      bookkeeping — filing contacts, rebuilding the one-round pile from scratch
//      each resolution, and forgetting a hex when a unit is publicly destroyed
//      (§11). `state.intel[playerId]` is already exactly what this player knows.
//      This module only projects it. If you find yourself computing *whether*
//      something is visible here, the rule belongs in resolve().
//   2. **It is a projection, not a deep clone.** Arrays are rebuilt so a caller
//      cannot splice the real state, but the objects inside them are shared
//      where nothing is masked. That is safe because the presentation layer
//      never mutates game state (CLAUDE.md's architecture rule), and copying
//      every unit on every frame would be waste. Static reveals are the one
//      exception, and only because masking forces a new object.

import {
  opponentOf,
  type GameEvent,
  type GameState,
  type MaskedStaticKind,
  type PlayerId,
  type PlayerIntel,
  type SpottedKind,
  type StaticKind,
  type UnitKind,
  type VisibleEvent,
  type VisibleGameState,
  type VisiblePlayerIntel,
} from './types';

// ---------------------------------------------------------------------------
// The decoy mask (spec §12)
// ---------------------------------------------------------------------------

/**
 * What the enemy is told a spotted static asset is.
 *
 * The whole of §12's indistinguishability principle on the intel side: a decoy
 * enters the enemy's map as a bunker site and stays labelled that way until a
 * missile proves otherwise. The return type is MaskedStaticKind, which cannot
 * express 'decoy' at all — so this cannot be got wrong by a later edit, only
 * deleted outright.
 */
function maskStaticKind(kind: StaticKind): MaskedStaticKind {
  return kind === 'decoy' ? 'bunker' : kind;
}

/**
 * The same mask for an ASSET_SPOTTED, which may also name a launcher.
 *
 * 'drone' is unreachable rather than unhandled: no detector in the game ever
 * reveals an enemy drone (spec §2, §11 — drones do not even reveal each other),
 * and resolve()'s recon phase skips them explicitly before emitting. It throws
 * instead of returning something plausible because a drone arriving here would
 * mean the engine had invented a detector, and a filter that quietly relabelled
 * it would hide the bug behind a working screen.
 */
function maskSpottedKind(kind: UnitKind): SpottedKind {
  switch (kind) {
    case 'decoy':
      return 'bunker';
    case 'launcher':
    case 'bunker':
    case 'interceptor':
      return kind;
    case 'drone':
      throw new Error(
        'filterEventsForPlayer(): ASSET_SPOTTED named a drone — no detector may reveal one',
      );
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * One player's picture of the enemy, redacted.
 *
 * `contacts` passes through untouched: a LauncherContact is a hex plus how it
 * was spotted, with no unit id, no owner and no identity to mask — intel is
 * keyed by place, never by unit (spec §11), which is what makes cross-round
 * tracking of a specific enemy launcher impossible even for a modified client.
 */
function filterIntel(intel: PlayerIntel): VisiblePlayerIntel {
  return {
    staticReveals: intel.staticReveals.map((reveal) => ({
      hex: reveal.hex,
      kind: maskStaticKind(reveal.kind),
      round: reveal.round,
    })),
    contacts: [...intel.contacts],
  };
}

/**
 * What `playerId` is allowed to see of the board right now (spec §6, §11).
 *
 * The enemy is not *downgraded* in the output — they are absent from it. Enemy
 * units are dropped from `units` entirely, and everything this player knows
 * about them lives in `intel`, keyed by hex. That is §11's "you learn a place,
 * not an identity" made structural: VisibleGameState has no field capable of
 * holding an enemy UnitId, so no future change can leak one by accident.
 *
 * Three things are deliberately NOT redacted:
 *
 *   - **`map`.** Terrain is public and the board is rotationally symmetric, so
 *     there is nothing to hide and hiding it would achieve nothing. Hidden
 *     information covers assets, never tiles — the filter must never strip or
 *     mask MapData (spec §11).
 *   - **The viewer's own destroyed units.** They stay in `units`. Your own
 *     losses are your own knowledge, and the renderer decides whether to draw a
 *     wreck.
 *   - **`round`, `phase`, `deadHandFor`, `outcome`.** Public for the same
 *     reason their events are: DEAD_HAND_TRIGGERED and GAME_OVER go to both
 *     players (spec §6), so concealing the state they describe would only
 *     desynchronise the client from a log it already received.
 *
 * `droneRespawnIn` narrows to this player's own counter. DRONE_RESPAWNED is
 * owner-only precisely so the enemy cannot time your recon coming back online —
 * leaving the opponent's counter in the state would hand them that fact
 * directly and make filtering the event pointless.
 */
export function filterForPlayer(
  state: GameState,
  playerId: PlayerId,
): VisibleGameState {
  return {
    round: state.round,
    phase: state.phase,
    map: state.map,
    units: state.units.filter((unit) => unit.owner === playerId),
    intel: filterIntel(state.intel[playerId]),
    droneRespawnIn: state.droneRespawnIn[playerId],
    deadHandFor: state.deadHandFor,
    outcome: state.outcome,
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * The events `playerId` is allowed to receive, in the order resolve() emitted
 * them (spec §6's visibility table).
 *
 * Handed the log and a player id and **nothing else** — no GameState. That is a
 * deliberate constraint, not an oversight: it is what lets a whole match's
 * replay be re-filtered for either player without reconstructing the state of
 * each round. It is also why every owner-only event carries `owner` explicitly;
 * a UnitId is an opaque string that nothing may derive meaning from, so this
 * function could not otherwise discover whose event it is reading.
 *
 * **`ASSET_SPOTTED` is the trap, and it is the only one.** Every other
 * owner-only event means "`owner` is who may see this". On ASSET_SPOTTED,
 * `owner` is the side that was *photographed*, so the audience is that player's
 * opponent — reading it like the others is exactly backwards, and the resulting
 * filter shows each player their own assets while hiding the enemy's. It looks
 * entirely reasonable in a diff, which is why the routing below is written with
 * `opponentOf` rather than a bare `!==`: the direction is stated, not implied.
 *
 * Public is the *narrow* set, not the default. Note especially that
 * UNIT_DESTROYED goes out unmasked and reports a dead decoy truthfully as a
 * decoy (spec §6): masking it would fool nobody, because the absence of a dead
 * hand in the same instant gives it away anyway. "Mask everything decoy-shaped"
 * is the wrong instinct here — the decoy's secret is what it is while it lives,
 * not what it was when it died.
 */
export function filterEventsForPlayer(
  events: readonly GameEvent[],
  playerId: PlayerId,
): VisibleEvent[] {
  const visible: VisibleEvent[] = [];

  for (const event of events) {
    switch (event.type) {
      // --- Owner only: `owner` is the recipient ----------------------------
      case 'UNIT_MOVED':
      case 'MOVE_FAILED':
      case 'BUNKER_HIT':
      case 'DRONE_MOVED':
      case 'DRONE_RESPAWNED':
        if (event.owner === playerId) visible.push(event);
        break;

      // --- Spotting player only: `owner` is the recipient's ENEMY ----------
      case 'ASSET_SPOTTED':
        if (opponentOf(event.owner) === playerId) {
          visible.push({ ...event, kind: maskSpottedKind(event.kind) });
        }
        break;

      // --- Both players ----------------------------------------------------
      // MARCH_DETECTED and DRONE_DOWNED both carry an `owner` and are still
      // public: the field names whose *unit* the event is about, not who may
      // read it. Loud actions are heard by everybody (§11), and a drone's death
      // hex is already known to the base owner who caused it (§6).
      case 'LAUNCH_DETECTED':
      case 'MARCH_DETECTED':
      case 'MISSILE_INTERCEPTED':
      case 'IMPACT':
      case 'UNIT_DESTROYED':
      case 'DRONE_DOWNED':
      case 'DEAD_HAND_TRIGGERED':
      case 'GAME_OVER':
        visible.push(event);
        break;

      default: {
        // Every event kind must be given an audience above (spec §6). The
        // `never` assignment turns "someone added an event and forgot to
        // classify it" into a compile error, rather than a silent drop that
        // would quietly delete information from one player's log.
        const unrouted: never = event;
        throw new Error(
          `filterEventsForPlayer(): event with no audience: ${JSON.stringify(unrouted)}`,
        );
      }
    }
  }

  return visible;
}
