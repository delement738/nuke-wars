// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// Launcher movement: reachability and order validation (spec §9; build-order
// step 4 in the post-pivot numbering — this file predates it and originally
// cited the old step 2). This module answers one question — "may this unit
// legally end its move on this hex?" — and nothing else.
//
// It deliberately does NOT apply moves. Mutating state, emitting UNIT_MOVED
// events, and adjudicating simultaneous-move conflicts (spec §9) belong to
// resolve(), in its own session. Keeping validation pure and separate is what
// lets the UI call reachableHexes() to highlight legal destinations and be
// guaranteed the highlight matches what the engine will actually accept.

import { RULES, TERRAIN_DEFS, UNIT_DEFS } from './defs';
import { axialToOffset, hexKey, neighbors, type Hex } from './hex';
import { tileAt } from './map';
import type {
  GameState,
  GroundOrder,
  MarchOrder,
  MoveOrder,
  PlayerId,
  Unit,
} from './types';

export type MoveIllegalReason =
  | 'UNKNOWN_UNIT' // no unit in the game carries that id
  | 'NOT_YOUR_UNIT' // belongs to the other player
  | 'UNIT_DESTROYED' // already dead; corpses don't take orders
  | 'IMMOBILE_UNIT' // movement === 0 (interceptor, bunker, decoy)
  | 'AIR_UNIT' // the drone flies (FLY order, spec §11) — it never takes MOVE
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
 * Hexes blocked by other living GROUND units. Per spec §9, an occupied tile
 * blocks both *passing through* and *landing on* — you cannot route a launcher
 * through another piece, friendly or enemy. Destroyed units block nothing.
 *
 * Drones are excluded because they are not on the ground layer at all: "the
 * drone neither blocks nor is blocked" (spec §2, §9). This mattered from the
 * moment drones started flying (build-order step 5) — before that they sat on
 * their spawn hexes and the omission was invisible. A drone that blocked would
 * be a third detector by the back door: park it on a hex, watch an enemy
 * launcher's advance fail, and you have found a unit no rule says you may see.
 *
 * The decoy, by contrast, blocks exactly like any other ground unit, and must —
 * if it were passable, walking a launcher through a suspected site would
 * identify the fake for free (spec §12).
 */
function occupiedHexes(state: GameState, mover: Unit): Set<string> {
  const blocked = new Set<string>();
  for (const other of state.units) {
    if (other.id === mover.id || other.destroyed) continue;
    if (other.kind === 'drone') continue;
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
 * adding a rough terrain that costs 2 during a balance pass would be a data
 * edit in defs.ts with no change to this algorithm. In V1 there are only two
 * terrains and every legal step costs 1, so this currently behaves as a plain
 * breadth-first search — that is a property of the data, not an assumption
 * baked into the code.
 */
export function reachableHexes(
  state: GameState,
  unit: Unit,
  budget: number = UNIT_DEFS[unit.kind].movement,
): Map<string, ReachableHex> {
  const start: ReachableHex = { hex: unit.position, cost: 0 };
  const best = new Map<string, ReachableHex>([[hexKey(unit.position), start]]);

  // The drone's UNIT_DEFS movement is a straight-line FLIGHT range, not a
  // ground budget — it ignores terrain and units entirely (spec §11), so
  // running it through this flood fill would produce a confidently wrong
  // answer. Ground movement is launchers only (spec §9).
  //
  // This guard is also what makes the `budget` parameter safe: a caller passing
  // a forced-march budget for a drone gets the drone's own hex back, not a
  // 6-hex ground fill for a unit that has no ground budget at all.
  if (unit.kind !== 'launcher') return best;

  if (budget <= 0) return best;

  const blocked = occupiedHexes(state, unit);

  // Cheapest-first frontier. A real priority queue would be overkill: the map
  // is ~285 tiles and budgets are tiny (3), so the frontier never holds more
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
      if (!terrain.groundPassable) continue; // mountain

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
 * The ground budget an order spends (spec §9).
 *
 * The ONE difference between walking and forced-marching, and it lives here so
 * that the sim, the UI's target highlight and the CPU all read it from the same
 * function rather than each remembering which constant goes with which order
 * kind. A march that used the walking budget would silently offer three hexes
 * and charge the player a public reveal for them.
 *
 * Non-launchers get their own `UNIT_DEFS` number, which is 0 for everything
 * static and a flight range for the drone — neither reaches ground movement, and
 * `reachableHexes` refuses both regardless.
 */
export function groundBudget(unit: Unit, orderType: GroundOrder['type']): number {
  if (unit.kind !== 'launcher') return UNIT_DEFS[unit.kind].movement;
  return orderType === 'MARCH'
    ? RULES.forcedMarchMovement
    : UNIT_DEFS.launcher.movement;
}

/**
 * Whether `playerId` may issue this ground order against the *full* game state.
 *
 * Checks run most-specific-first so the reason is precise: a destination that
 * is off-map, a mountain, or occupied reports exactly that, rather than
 * collapsing into a vague OUT_OF_RANGE. Tests and UI messaging both depend on
 * that distinction.
 *
 * **MOVE and MARCH are validated by the same code on different budgets** (spec
 * §9). A forced march is not a different kind of movement — same terrain, same
 * occupancy rule, same standoff adjudication downstream — it is the same move
 * with a bigger allowance and a public price, so the only thing that may branch
 * on the order kind is `groundBudget`. Two separate validators would be two
 * places for the mountain rule to drift apart.
 *
 * Note this validates against true state, not the visibility-filtered state. In
 * V1.5 the server calls it with full knowledge, so a player can legally *order*
 * a move into a hex they can't see is blocked by an undetected enemy. Per spec §9 such an
 * order fails entirely at resolution — the unit holds position, no partial
 * advance. Applying that (and the same-hex standoff rule) belongs to resolve().
 */
function validateGround(
  state: GameState,
  playerId: PlayerId,
  order: GroundOrder,
): MoveValidation {
  const unit = state.units.find((u) => u.id === order.unitId);
  if (!unit) return { legal: false, reason: 'UNKNOWN_UNIT' };
  if (unit.owner !== playerId) return { legal: false, reason: 'NOT_YOUR_UNIT' };
  if (unit.destroyed) return { legal: false, reason: 'UNIT_DESTROYED' };
  // Checked before the immobility test so the drone gets its own honest
  // reason: it is not immobile, it simply moves by FLY, never by MOVE (§11).
  if (unit.kind === 'drone') return { legal: false, reason: 'AIR_UNIT' };
  if (UNIT_DEFS[unit.kind].movement <= 0) {
    return { legal: false, reason: 'IMMOBILE_UNIT' };
  }

  const destination = hexKey(order.destination);
  if (destination === hexKey(unit.position)) {
    return { legal: false, reason: 'SAME_HEX' };
  }

  const tile = tileAt(state.map, axialToOffset(order.destination));
  if (!tile) return { legal: false, reason: 'OFF_MAP' };
  if (!TERRAIN_DEFS[tile.terrain].groundPassable) {
    return { legal: false, reason: 'IMPASSABLE_TERRAIN' };
  }
  if (occupiedHexes(state, unit).has(destination)) {
    return { legal: false, reason: 'TILE_OCCUPIED' };
  }

  const reached = reachableHexes(
    state,
    unit,
    groundBudget(unit, order.type),
  ).get(destination);
  if (!reached) return { legal: false, reason: 'OUT_OF_RANGE' };

  return { legal: true, cost: reached.cost };
}

/** Whether `playerId` may issue this MOVE order (spec §9). */
export function validateMove(
  state: GameState,
  playerId: PlayerId,
  order: MoveOrder,
): MoveValidation {
  return validateGround(state, playerId, order);
}

/**
 * Whether `playerId` may issue this MARCH order (spec §9, §11).
 *
 * Identical to `validateMove` except for the budget — see `validateGround`.
 *
 * **A march to a hex the launcher could have walked to is legal, deliberately.**
 * Rejecting one would be a new rule that costs the player an option and buys
 * nothing: paying a public reveal for a short move is exactly the feint this
 * feature makes possible, since the enemy learns a hex you have already left and
 * may spend a counter-battery volley on it. Whether that trade is worth it is
 * the player's judgement, not the validator's.
 */
export function validateMarch(
  state: GameState,
  playerId: PlayerId,
  order: MarchOrder,
): MoveValidation {
  return validateGround(state, playerId, order);
}
