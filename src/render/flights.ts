// RENDER LAYER — where each missile goes in a replay (presentation phase,
// session 2). Pure: no Pixi, no store.
//
// A missile's whole flight is public (spec §6, §10): `LAUNCH_DETECTED` gives its
// origin and target to both players, `RULES.missileSpeed` says how far it gets
// per pass, and its own `MISSILE_INTERCEPTED` or `IMPACT` says where it ended.
// So the replay never guesses and never needs anything secret — in particular
// never a launcher id, which neither the events nor `VisibleMissile` carry
// (gotcha 65).
//
// Positions are indexes into `hexLine(origin, target)`: 0 is the origin, and
// index i is `path[i - 1]` in the sim's terms, so a missile with `traveled = t`
// is over `line[t]`. Each pass it covers the next `missileSpeed` indexes, which
// is how a leg is found without replaying the sim: the leg an end falls in
// starts at the last multiple of the speed before it.

import { RULES } from '../sim/defs';
import { hexKey, hexLine, type Hex } from '../sim/hex';
import type { MissileId, PlayerId, Unit, VisibleEvent, VisibleMissile } from '../sim/types';

/** A stretch of a missile's line, as indexes into `hexLine(origin, target)`. */
export interface FlightLeg {
  from: number;
  to: number;
}

/**
 * Everything the replay draws for one missile, worked out from public facts
 * only: its `LAUNCH_DETECTED` (or last round's `VisibleMissile`), the speed rule,
 * and its own `MISSILE_INTERCEPTED` / `IMPACT`.
 */
export interface Flight {
  id: MissileId;
  line: Hex[];
  /** Colour only: the viewer's missile or the enemy's. */
  mine: boolean;
  /** Drawn by the launch clip; null for a missile fired in an earlier round. */
  launchLeg: FlightLeg | null;
  /** The dive drawn at the start of the intercept/impact clip, when the launch
   *  clip did not already carry it there (a missile carried between rounds, or
   *  the dead hand's second pass). */
  finalLeg: FlightLeg | null;
  end: 'impact' | 'intercepted' | 'in-flight';
}

const same = (a: Hex, b: Hex): boolean => a.q === b.q && a.r === b.r;

/** A launch from one of the viewer's own launchers is theirs (spec §6: the
 *  origin identifies the firer to its owner and to nobody else). */
function isOwnLaunch(own: readonly Unit[], origin: Hex): boolean {
  return own.some(
    (unit) => unit.kind === 'launcher' && !unit.destroyed && same(unit.position, origin),
  );
}

/**
 * Plan every missile the replay will show. `before` is the viewer's in-flight
 * list from the pre-round board (`replay.from.missiles`); `own` is their units
 * from the same board.
 *
 * Walks the events in order, like the timeline, and never sorts. A missile the
 * plan cannot place (an id it never saw launched) is simply absent: its impact
 * still gets its burst, drawn from the hex alone.
 */
export function planFlights(
  events: readonly VisibleEvent[],
  before: readonly VisibleMissile[],
  own: readonly Unit[],
): Map<MissileId, Flight> {
  const flights = new Map<MissileId, Flight>();
  // Where each missile stood when this replay began: 0 for one launched in it.
  const startedAt = new Map<MissileId, number>();
  const ownerIds = new Set(own.map((unit) => unit.owner));

  for (const m of before) {
    flights.set(m.id, {
      id: m.id,
      line: hexLine(m.origin, m.target),
      mine: ownerIds.has(m.owner),
      launchLeg: null,
      finalLeg: null,
      end: 'in-flight',
    });
    startedAt.set(m.id, m.traveled);
  }

  for (const event of events) {
    if (event.type === 'LAUNCH_DETECTED') {
      const line = hexLine(event.origin, event.target);
      flights.set(event.missileId, {
        id: event.missileId,
        line,
        mine: isOwnLaunch(own, event.origin),
        launchLeg: { from: 0, to: Math.min(RULES.missileSpeed, line.length - 1) },
        finalLeg: null,
        end: 'in-flight',
      });
      startedAt.set(event.missileId, 0);
      continue;
    }

    if (event.type !== 'IMPACT' && event.type !== 'MISSILE_INTERCEPTED') continue;
    const flight = flights.get(event.missileId);
    if (!flight) continue;

    const endAt =
      event.type === 'IMPACT'
        ? flight.line.length - 1
        : flight.line.findIndex((hex) => same(hex, event.hex));
    flight.end = event.type === 'IMPACT' ? 'impact' : 'intercepted';
    const start = startedAt.get(flight.id) ?? 0;
    if (endAt <= start) continue; // not on its line: burst only

    // The pass this end happened in began at the last multiple of the speed
    // (counted from where the missile started the replay) before it.
    const legFrom = start + Math.floor((endAt - start - 1) / RULES.missileSpeed) * RULES.missileSpeed;
    if (flight.launchLeg && legFrom === flight.launchLeg.from) {
      flight.launchLeg = { from: legFrom, to: endAt };
    } else {
      flight.finalLeg = { from: legFrom, to: endAt };
    }
  }

  return flights;
}

// --- between rounds: missiles still in the air -----------------------------

/** How the board shows one in-flight missile between rounds. */
export interface MissileMarker {
  id: MissileId;
  mine: boolean;
  origin: Hex;
  /** Where it is now: the last hex it entered (its origin if it has not moved). */
  at: Hex;
  target: Hex;
  /** Rounds until it lands, from the speed rule — 1 for every V1 carried missile. */
  roundsLeft: number;
  /** The warning written beside its target hex. */
  label: string;
}

/**
 * The static board's in-flight missiles, from `VisibleGameState.missiles` —
 * both players', since every launch was announced to both (spec §6, §10).
 * `viewer` decides only the colour and the wording: your strike or theirs.
 */
export function missileMarkers(
  missiles: readonly VisibleMissile[],
  viewer: PlayerId,
): MissileMarker[] {
  return missiles.map((m) => {
    const line = hexLine(m.origin, m.target);
    const remaining = line.length - 1 - m.traveled;
    const roundsLeft = Math.max(1, Math.ceil(remaining / RULES.missileSpeed));
    const mine = m.owner === viewer;
    return {
      id: m.id,
      mine,
      origin: m.origin,
      at: line[Math.min(m.traveled, line.length - 1)],
      target: m.target,
      roundsLeft,
      label: inboundText(mine, roundsLeft),
    };
  });
}

/** The warning's words — one wording for the board and the replay. */
export function inboundText(mine: boolean, roundsLeft: number): string {
  const when = roundsLeft === 1 ? 'lands next round' : `lands in ${roundsLeft} rounds`;
  return `${mine ? 'YOUR STRIKE' : 'INBOUND'} — ${when}`;
}

/** Rounds a flight parked at line index `at` still needs to land. */
export function roundsLeftFrom(flight: Flight, at: number): number {
  return Math.max(1, Math.ceil((flight.line.length - 1 - at) / RULES.missileSpeed));
}

/**
 * Which line each warning goes on: identical words on one hex are drawn once
 * (a 2-missile strike), different words on one hex stack. Returns null for a
 * duplicate. `seen` is keyed by hex, and the caller keeps it for one redraw.
 */
export function warningLine(seen: Map<string, string[]>, target: Hex, text: string): number | null {
  const key = hexKey(target);
  const texts = seen.get(key) ?? [];
  if (texts.includes(text)) return null;
  texts.push(text);
  seen.set(key, texts);
  return texts.length - 1;
}
