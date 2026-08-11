// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// The recon drone: flight validation, flight resolution, and the reveal swath
// (spec §10, §11; build-order step 5). Same split as movement.ts — this module
// answers questions and computes geometry; resolve() applies the answers,
// updates intel, and emits events.
//
// The drone is the only way to find a hidden asset, and it obeys almost none of
// the ground rules:
//   - it flies a straight `hexLine` and ignores terrain completely — a mountain
//     is nothing to an aircraft, so there is no passability check anywhere here
//   - it neither blocks nor is blocked by ground units, and never sees, blocks
//     or is blocked by the enemy drone (spec §2)
//   - missiles cannot touch it; the ONLY thing that kills it is entering enemy
//     interceptor coverage (spec §10)
// so nothing in this file may be routed through movement.ts's ground flood
// fill, and nothing in movement.ts may be handed a drone.

import { RULES, UNIT_DEFS } from './defs';
import { isCoveredByEnemy } from './coverage';
import {
  axialToOffset,
  distance,
  hexKey,
  hexLine,
  hexesInRange,
  type Hex,
} from './hex';
import { tileAt } from './map';
import type { FlyOrder, GameState, PlayerId, Unit } from './types';

/**
 * Why a FLY order was rejected.
 *
 * Note what is *absent*: there is no impassable-terrain reason and no occupied-
 * tile reason, because neither can ever apply to an aircraft (spec §2, §11).
 * Adding one would be the same category error as feeding the drone to the
 * ground movement flood fill.
 *
 * `NOT_AIR_UNIT` is the mirror of movement.ts's `AIR_UNIT`: between them, a
 * launcher handed a FLY and a drone handed a MOVE both fail with a reason that
 * names the mistake instead of quietly looking like a range problem.
 */
export type FlyIllegalReason =
  | 'UNKNOWN_UNIT' // no unit in the game carries that id
  | 'NOT_YOUR_UNIT' // belongs to the other player
  | 'UNIT_DESTROYED' // shot down and still awaiting respawn (spec §11)
  | 'NOT_AIR_UNIT' // only the drone flies; launchers use MOVE
  | 'SAME_HEX' // "give no order to hover" (spec §11) — this is not a no-op
  | 'OFF_MAP' // destination isn't a real tile
  | 'OUT_OF_RANGE'; // straight-line distance exceeds the drone's flight range

export type FlyValidation =
  | { legal: true; distance: number }
  | { legal: false; reason: FlyIllegalReason };

/**
 * The result of one drone's flight for one round.
 *
 * `path` is the hexes the drone **safely traversed**, always starting with the
 * hex it took off from, and it is the sole input to the reveal swath. If the
 * drone was shot down, `path` stops at the last hex it survived and the death
 * hex is reported separately: a drone that is shot down transmits nothing from
 * where it died (spec §11), so building the swath from `path` is correct by
 * construction and no caller has to remember to drop the last entry.
 *
 * Intel from earlier hexes of the same flight is kept — this is live
 * transmission, not recovered wreckage.
 */
export interface DroneFlight {
  path: Hex[];
  /** The hex the drone was destroyed entering, or null if it survived. */
  downedAt: Hex | null;
}

/**
 * A player's drone, alive or destroyed, or undefined if they have none.
 *
 * There is exactly one drone unit per player for the whole match: when it is
 * shot down the unit stays in `GameState.units` flagged `destroyed`, and the
 * respawn revives that same unit at the spawn hex rather than appending a new
 * one (spec §11 — respawns are unlimited, so a fresh id per death would grow
 * the unit array all match for nothing). Reusing the id leaks nothing: no
 * detector ever reports an enemy drone, so no drone id is ever observable
 * across the wire.
 */
export function droneFor(
  units: readonly Unit[],
  player: PlayerId,
): Unit | undefined {
  return units.find((unit) => unit.kind === 'drone' && unit.owner === player);
}

/**
 * Whether `playerId` may issue this FLY order against the *full* game state.
 *
 * Every rejection reason here is derivable from information the ordering player
 * already holds — their own drone's position, the drone's range, and the public
 * map (§11). That is why a rejected FLY emits nothing at resolution: unlike a
 * blocked MOVE, no failure here can have been caused by hidden information, so
 * there is no `MOVE_FAILED` equivalent to report (spec §9's reasoning applied to
 * the air layer). An honest UI cannot produce any of these.
 */
export function validateFly(
  state: GameState,
  playerId: PlayerId,
  order: FlyOrder,
): FlyValidation {
  const unit = state.units.find((u) => u.id === order.unitId);
  if (!unit) return { legal: false, reason: 'UNKNOWN_UNIT' };
  if (unit.owner !== playerId) return { legal: false, reason: 'NOT_YOUR_UNIT' };
  if (unit.kind !== 'drone') return { legal: false, reason: 'NOT_AIR_UNIT' };
  if (unit.destroyed) return { legal: false, reason: 'UNIT_DESTROYED' };

  if (hexKey(order.destination) === hexKey(unit.position)) {
    return { legal: false, reason: 'SAME_HEX' };
  }

  if (!tileAt(state.map, axialToOffset(order.destination))) {
    return { legal: false, reason: 'OFF_MAP' };
  }

  // Straight-line distance, NOT a terrain-aware path cost. The drone flies over
  // everything, so the flood fill's notion of "reachable" has no meaning here.
  const flown = distance(unit.position, order.destination);
  if (flown > UNIT_DEFS.drone.movement) {
    return { legal: false, reason: 'OUT_OF_RANGE' };
  }

  return { legal: true, distance: flown };
}

/**
 * Fly `drone` to `destination` along `hexLine`, checking for interception
 * hex-by-hex (spec §10).
 *
 * The origin is deliberately **not** checked. Coverage kills on *entry* only, so
 * a drone can never be sitting inside enemy coverage at the start of a round —
 * it would have died entering that hex, and a fresh drone spawns in its owner's
 * own home zone, where no enemy base may be placed (spec §7, §12). Hovering is
 * therefore always safe, which is what makes "give no order to hover" a real
 * choice rather than a trap.
 *
 * Passing the drone's own position as `destination` is how a hover is resolved:
 * `hexLine(a, a)` is `[a]`, so the loop body never runs and the drone transmits
 * its own hex's swath. No special case needed.
 *
 * Takes the unit array rather than a GameState because it reads nothing else —
 * in particular it must never consult the map, since terrain is irrelevant to
 * an aircraft.
 */
export function flyDrone(
  units: readonly Unit[],
  drone: Unit,
  destination: Hex,
): DroneFlight {
  const line = hexLine(drone.position, destination);

  const path: Hex[] = [line[0]];
  for (const hex of line.slice(1)) {
    if (isCoveredByEnemy(units, hex, drone.owner)) {
      return { path, downedAt: hex };
    }
    path.push(hex);
  }

  return { path, downedAt: null };
}

/**
 * The hexes revealed by a flight: every hex on `path`, plus everything within
 * `RULES.reconSwathRadius` of it — at radius 1, the 3-wide corridor of §11.
 *
 * Returned as `hexKey` strings because the only thing done with it is testing
 * whether a unit is standing inside it, and the caller iterates units rather
 * than hexes (which is also what keeps `ASSET_SPOTTED` emission in canonical
 * `GameState.units` order, spec §9).
 *
 * Corridor hexes that fall off the edge of the map are left in. They can never
 * match a unit — nothing exists off-map — so filtering them would cost a map
 * lookup per hex to change nothing.
 *
 * The radius is read from `RULES` rather than being the `neighbors()` call it
 * looks like it wants to be, because it is a balance lever with a non-obvious
 * interaction with `RULES.interceptorCoverageRadius` — see the note there
 * before touching either.
 */
export function reconSwath(path: readonly Hex[]): Set<string> {
  const swath = new Set<string>();
  for (const hex of path) {
    for (const seen of hexesInRange(hex, RULES.reconSwathRadius)) {
      swath.add(hexKey(seen));
    }
  }
  return swath;
}
