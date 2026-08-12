// UI LAYER — turning a filtered event into a line of English (build-order step 9).
//
// The HUD's event log is the player's permanent history: every event they were
// allowed to see, for the whole match (spec §6, §11). This module writes it.
//
// Two rules constrain every line below, and both are hidden-information rules
// rather than style:
//
//   1. **Never derive anything from a `UnitId`.** Ids are opaque strings that
//      nothing may read meaning from (§6) — they happen to be readable
//      (`p1-launcher-2`) only because the engine's own tests are their audience.
//      `UNIT_DESTROYED` is public and names *any* unit, so a log line that
//      printed or parsed its id would hand the enemy the trackable identity §11
//      keys all intel by hex to withhold. Where a line needs a unit's kind, it
//      either reads the `kind` on the event or looks the id up in the viewer's
//      *own* units — never in a string.
//   2. **Say only what the event says.** These lines are written from a
//      `VisibleEvent`, which is already redacted. If a phrasing needs a fact
//      that is not in the event, the fact is not the player's to have.
//
// So `UNIT_DESTROYED` reads "Launcher destroyed at c2 r16" and never "their
// launcher": the player can see their own units on the map, and the log does not
// editorialise about whose a wreck is.

import { axialToOffset, type Hex } from '../sim/hex';
import type {
  Outcome,
  PlayerId,
  SpottedKind,
  Unit,
  VisibleEvent,
} from '../sim/types';

/** What recon calls each thing it can photograph (spec §11, §12). */
const SPOTTED_LABEL: Record<SpottedKind, string> = {
  launcher: 'launcher',
  bunker: 'bunker site',
  interceptor: 'interceptor base',
};

/**
 * A hex as the player sees it on the board: map column and row.
 *
 * Offset coordinates, not axial. Axial is the sim's internal system and its `r`
 * skews with the column — telling a player their launcher is at "q2 r15" when it
 * is plainly on row 16 of the map would be true and useless.
 */
export function hexLabel(hex: Hex): string {
  const { col, row } = axialToOffset(hex);
  return `c${col} r${row}`;
}

/** The kind of one of the viewer's own units, for owner-only events. */
function ownKind(units: readonly Unit[], unitId: string): string {
  return units.find((unit) => unit.id === unitId)?.kind ?? 'unit';
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Spec §4's outcomes, from the point of view of whoever is reading. */
export function describeOutcome(outcome: Outcome, viewer: PlayerId): string {
  switch (outcome.type) {
    case 'MUTUAL_ANNIHILATION':
      return 'Mutual annihilation — both bunkers destroyed. Draw.';
    case 'DECAPITATION':
      return outcome.winner === viewer
        ? 'Victory by decapitation — the enemy bunker is gone.'
        : 'Defeat — your bunker was destroyed.';
    case 'CAPITULATION':
      return outcome.winner === viewer
        ? 'Victory — the enemy resigned.'
        : 'Defeat — you resigned.';
    case 'MUTUAL_DISARMAMENT':
      return 'Mutual disarmament — neither side has a launcher left. Draw.';
    case 'DISARMAMENT':
      return outcome.winner === viewer
        ? 'Victory by disarmament — the enemy has no launchers left.'
        : 'Defeat — you have no launchers left.';
    case 'ARMISTICE':
      return 'Armistice — the round cap was reached. Draw.';
  }
}

/**
 * One log line for one event, as `viewer` reads it.
 *
 * `ownUnits` is the viewer's own roster from their `VisibleGameState` — it can
 * never contain an enemy unit, which is precisely why looking a unit id up in it
 * is safe for the owner-only events and impossible for anything else.
 *
 * The switch is exhaustive over `VisibleEvent` with a `never` fallthrough, so an
 * event kind added to the engine is a compile error here rather than a blank
 * line in the player's history.
 */
export function describeEvent(
  event: VisibleEvent,
  viewer: PlayerId,
  ownUnits: readonly Unit[],
): string {
  switch (event.type) {
    case 'UNIT_MOVED':
      return `${capitalise(ownKind(ownUnits, event.unitId))} moved ${hexLabel(event.from)} → ${hexLabel(event.to)}.`;

    case 'MOVE_FAILED':
      // No hex, no blocker, no reason — the event carries none of it on purpose
      // (§9), because "someone was parked there" and "we raced for it" must read
      // identically.
      return `A ${ownKind(ownUnits, event.unitId)}'s advance was blocked. It held position.`;

    case 'BUNKER_HIT':
      return `Your bunker took a hit at ${hexLabel(event.hex)} — ${event.hpRemaining} left.`;

    case 'DRONE_MOVED':
      return event.path.length <= 1
        ? `Drone held station at ${hexLabel(event.to)}, watching its own corridor.`
        : `Drone flew ${hexLabel(event.from)} → ${hexLabel(event.to)}, transmitting from ${event.path.length} hexes.`;

    case 'ASSET_SPOTTED':
      // A spotted decoy arrives here already masked as a bunker (§12) — this
      // layer cannot tell, which is the point. `SpottedKind` has no 'decoy'
      // member for SPOTTED_LABEL to have a row for.
      return `Recon spotted an enemy ${SPOTTED_LABEL[event.kind]} at ${hexLabel(event.hex)}.`;

    case 'DRONE_RESPAWNED':
      return `Replacement drone on station at ${hexLabel(event.hex)}.`;

    case 'LAUNCH_DETECTED':
      return `Launch detected — ${hexLabel(event.origin)} → ${hexLabel(event.target)}.`;

    case 'MISSILE_INTERCEPTED':
      return `Missile intercepted over ${hexLabel(event.hex)} — a base covers that hex.`;

    case 'IMPACT':
      // Says nothing about what was hit, including whether anything was (§6).
      return `Impact at ${hexLabel(event.hex)}.`;

    case 'UNIT_DESTROYED':
      return `${capitalise(event.kind)} destroyed at ${hexLabel(event.hex)}.`;

    case 'DRONE_DOWNED':
      return event.owner === viewer
        ? `Your drone was shot down at ${hexLabel(event.hex)}.`
        : `An enemy drone was shot down at ${hexLabel(event.hex)}.`;

    case 'DEAD_HAND_TRIGGERED':
      return event.playerId === viewer
        ? 'DEAD HAND — your bunker is destroyed. One final volley.'
        : 'DEAD HAND — the enemy bunker is destroyed. They fire one final volley.';

    case 'GAME_OVER':
      return `Game over. ${describeOutcome(event.outcome, viewer)}`;

    default: {
      const unwritten: never = event;
      throw new Error(
        `describeEvent(): no log line for ${JSON.stringify(unwritten)}`,
      );
    }
  }
}
