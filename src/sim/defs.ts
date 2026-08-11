// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// Balance tables. Per CLAUDE.md's data-table rule, every tunable stat lives
// here as plain data keyed by string ID, never hardcoded in logic. The goal is
// that a balance pass is an edit to *this file only* — a one-line git diff you
// can review, revert, or bisect. Combined with the determinism rule (same
// state + orders + seed always resolves identically), that means you can replay
// an identical match with exactly one number changed and see what it did.
//
// `as const satisfies Record<...>` is doing three jobs at once:
//   - completeness — add a UnitKind or Terrain and the build fails until it has
//     a row here, so a new piece can never silently read back `undefined`
//   - immutability — `as const` stops stray code overwriting tuned numbers
//   - precision — the compiler still knows launcher movement is exactly 2,
//     which a plain `: Record<...>` annotation would widen away to `number`

import type { Terrain } from './map';
import type { UnitKind } from './types';

export interface UnitDef {
  /**
   * Movement budget per round, spent against `TerrainDef.moveCost`.
   * 0 = immobile.
   *
   * Tuning note: this number is meaningless in isolation — what matters is its
   * ratio to missile range (spec §7: SRM 5, MRM 9) and radar radius (6). At 2,
   * a launcher cannot outrun retaliation after a launch reveals its origin hex,
   * which is what makes firing a commitment rather than a hit-and-run.
   */
  movement: number;
}

export const UNIT_DEFS = {
  launcher: { movement: 2 }, // spec §7: "Launcher movement: 2 hexes/round"
  radar: { movement: 0 }, // spec §2: fixed
  interceptor: { movement: 0 }, // spec §2: fixed
  leader: { movement: 0 }, // spec §2: static in V1 (relocation is deferred to V2)
} as const satisfies Record<UnitKind, UnitDef>;

export interface TerrainDef {
  passable: boolean;
  /** Cost to enter this tile. Not read when `passable` is false. */
  moveCost: number;
}

export const TERRAIN_DEFS = {
  plains: { passable: true, moveCost: 1 },
  urban: { passable: true, moveCost: 1 }, // spec §2: visual flavor only in V1
  mountain: { passable: false, moveCost: Infinity }, // spec §2: impassable
} as const satisfies Record<Terrain, TerrainDef>;

/**
 * Round-level rules that are numbers rather than logic, kept here for the same
 * reason as the tables above: they are balance levers, not invariants.
 *
 * NOTE: neither is enforced yet. Both are order-*batch* rules — they constrain
 * a player's whole set of orders for a round, which `validateMove` (one order,
 * in isolation) structurally cannot see. Enforcement lands with resolve().
 */
export const RULES = {
  /** Orders a player may queue in one round (spec §7). */
  ordersPerRound: 4,

  /**
   * MOVE orders a single unit may receive in one round (spec §9).
   *
   * At 1, spec §7's "Launcher movement: 2 hexes/round" is literally true.
   * Raising this to 2 would let a player spend two of their four orders on one
   * launcher for 4 hexes of travel — which is a legitimate thing to try during
   * balance testing, but it doubles effective mobility and weakens the "firing
   * is a commitment" dynamic, so §7's stated range ratios would need revisiting
   * at the same time.
   */
  moveOrdersPerUnit: 1,
} as const;
