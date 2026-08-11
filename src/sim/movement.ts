// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// Launcher movement: reachability and order validation (spec §6–§8, build-order
// step 2). This module answers one question — "may this unit legally end its
// move on this hex?" — and nothing else.
//
// It deliberately does NOT apply moves. Mutating state, emitting UNIT_MOVED
// events, and adjudicating simultaneous-move conflicts (spec §9) belong to
// resolve(), in its own session. Keeping validation pure and separate is what
// lets the UI call reachableHexes() to highlight legal destinations and be
// guaranteed the highlight matches what the engine will actually accept.

import { TERRAIN_DEFS, UNIT_DEFS } from './defs';
import { axialToOffset, hexKey, neighbors, type Hex } from './hex';
import { tileAt } from './map';
import type { GameState, MoveOrder, PlayerId, Unit } from './types';

export type MoveIllegalReason =
  | 'UNKNOWN_UNIT' // no unit in the game carries that id
  | 'NOT_YOUR_UNIT' // belongs to the other player
  | 'UNIT_DESTROYED' // already dead; corpses don't take orders
  | 'IMMOBILE_UNIT' // movement === 0 (radar, interceptor, leader)
  | 'SAME_HEX' // destination is where it already stands
  | 'OFF_MAP' // destination isn't a real tile
  | 'IMPASSABLE_TERRAIN' // destination is a mountain
  | 'TILE_OCCUPIED' // another living unit is standing there
  | 'OUT_OF_RANGE'; // no route within the movement budget

export type MoveValidation =
  | { legal: true; cost: number }
  | { legal: false; reason: MoveIllegalReason };

export interface ReachableHex {
  hex: Hex;
  /** Cheapest total movement cost to reach this hex from the unit's position. */
  cost: number;
}

/**
 * Hexes blocked by other living units. Per the agreed V1 rule, an occupied tile
 * blocks both *passing through* and *landing on* — you cannot route a launcher
 * through another piece. Destroyed units block nothing.
 */
function occupiedHexes(state: GameState, mover: Unit): Set<string> {
  const blocked = new Set<string>();
  for (const other of state.units) {
    if (other.id === mover.id || other.destroyed) continue;
    blocked.add(hexKey(other.position));
  }
  return blocked;
}

/**
 * Every hex this unit could legally end its move on, keyed by `hexKey`, with
 * the cheapest cost of getting there. Always includes the unit's own hex at
 * cost 0 (validateMove rejects that separately as SAME_HEX).
 *
 * This is a cheapest-first flood fill, NOT a `distance() <= movement` check —
 * and the difference is the whole point. Mountains are impassable and units
 * block tiles, so a hex two steps away in a straight line can be genuinely
 * unreachable, or reachable only via a longer detour. Straight-line distance
 * and true travel cost are different numbers.
 *
 * Costs come from TERRAIN_DEFS.moveCost rather than being assumed to be 1, so
 * making urban tiles cost 2 during a balance pass is a data edit here with no
 * change to this algorithm.
 */
export function reachableHexes(
  state: GameState,
  unit: Unit,
): Map<string, ReachableHex> {
  const start: ReachableHex = { hex: unit.position, cost: 0 };
  const best = new Map<string, ReachableHex>([[hexKey(unit.position), start]]);

  const budget = UNIT_DEFS[unit.kind].movement;
  if (budget <= 0) return best;

  const blocked = occupiedHexes(state, unit);

  // Cheapest-first frontier. A real priority queue would be overkill: the map
  // is ~285 tiles and budgets are tiny (2), so the frontier never holds more
  // than a handful of entries and a linear scan for the minimum is faster.
  const frontier: ReachableHex[] = [start];

  while (frontier.length > 0) {
    let cheapest = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (frontier[i].cost < frontier[cheapest].cost) cheapest = i;
    }
    const [current] = frontier.splice(cheapest, 1);

    for (const next of neighbors(current.hex)) {
      const key = hexKey(next);
      if (blocked.has(key)) continue;

      const tile = tileAt(state.map, axialToOffset(next));
      if (!tile) continue; // off the edge of the map

      const terrain = TERRAIN_DEFS[tile.terrain];
      if (!terrain.passable) continue; // mountain

      const cost = current.cost + terrain.moveCost;
      if (cost > budget) continue;

      // Only keep going if this is a genuinely cheaper route than one already
      // found — otherwise the fill would revisit hexes forever.
      const existing = best.get(key);
      if (existing && existing.cost <= cost) continue;

      const entry: ReachableHex = { hex: next, cost };
      best.set(key, entry);
      frontier.push(entry);
    }
  }

  return best;
}

/**
 * Whether `playerId` may issue this MOVE order against the *full* game state.
 *
 * Checks run most-specific-first so the reason is precise: a destination that
 * is off-map, a mountain, or occupied reports exactly that, rather than
 * collapsing into a vague OUT_OF_RANGE. Tests and UI messaging both depend on
 * that distinction.
 *
 * Note this validates against true state, not the visibility-filtered state. In
 * V1.5 the server calls it with full knowledge, so a player can legally *order*
 * a move into a hex they can't see is blocked by an undetected enemy. Per spec §9 such an
 * order fails entirely at resolution — the unit holds position, no partial
 * advance. Applying that (and the same-hex standoff rule) belongs to resolve().
 */
export function validateMove(
  state: GameState,
  playerId: PlayerId,
  order: MoveOrder,
): MoveValidation {
  const unit = state.units.find((u) => u.id === order.unitId);
  if (!unit) return { legal: false, reason: 'UNKNOWN_UNIT' };
  if (unit.owner !== playerId) return { legal: false, reason: 'NOT_YOUR_UNIT' };
  if (unit.destroyed) return { legal: false, reason: 'UNIT_DESTROYED' };
  if (UNIT_DEFS[unit.kind].movement <= 0) {
    return { legal: false, reason: 'IMMOBILE_UNIT' };
  }

  const destination = hexKey(order.destination);
  if (destination === hexKey(unit.position)) {
    return { legal: false, reason: 'SAME_HEX' };
  }

  const tile = tileAt(state.map, axialToOffset(order.destination));
  if (!tile) return { legal: false, reason: 'OFF_MAP' };
  if (!TERRAIN_DEFS[tile.terrain].passable) {
    return { legal: false, reason: 'IMPASSABLE_TERRAIN' };
  }
  if (occupiedHexes(state, unit).has(destination)) {
    return { legal: false, reason: 'TILE_OCCUPIED' };
  }

  const reached = reachableHexes(state, unit).get(destination);
  if (!reached) return { legal: false, reason: 'OUT_OF_RANGE' };

  return { legal: true, cost: reached.cost };
}
