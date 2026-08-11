// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// Balance tables. Per CLAUDE.md's data-table rule, every tunable stat lives
// here as plain data keyed by string ID, never hardcoded in logic. The goal is
// that a balance pass is an edit to *this file only* — a one-line git diff you
// can review, revert, or bisect. Combined with the determinism rule (V1 combat
// reads no randomness at all), that means you can replay an identical match
// with exactly one number changed and see what it did.
//
// Every number here is a spec §7 first draft, untested until playtest.
//
// `as const satisfies Record<...>` is doing three jobs at once:
//   - completeness — add a UnitKind or Terrain and the build fails until it has
//     a row here, so a new piece can never silently read back `undefined`
//   - immutability — `as const` stops stray code overwriting tuned numbers
//   - precision — the compiler still knows launcher movement is exactly 3,
//     which a plain `: Record<...>` annotation would widen away to `number`

import type { Offset } from './hex';
import type { Terrain } from './map';
import type { PlayerId, UnitKind } from './types';

export interface UnitDef {
  /**
   * Distance budget per round. For ground units this is spent against
   * `TerrainDef.moveCost` by the movement flood fill; 0 = immobile.
   *
   * The drone's 6 is a *flight* range, not a ground budget — it flies a
   * straight `hexLine` ignoring terrain and units (spec §11), so nothing in
   * movement.ts may ever apply this number. `validateMove` rejects drone MOVE
   * orders outright for exactly that reason.
   *
   * Tuning note: launcher movement is meaningless in isolation — what matters
   * is its ratio to missile range (6) and map width (19). At 3, a launcher
   * gets roughly two rounds of maneuver before first contact, and cannot
   * outrun retaliation after a launch reveals its origin, which is what makes
   * firing a commitment rather than a hit-and-run (spec §3, §7).
   */
  movement: number;
  /**
   * Hits to destroy. Damage is hits-based with no variance (spec §3): every
   * missile that lands deals exactly 1, and hits stack within a round, so two
   * missiles on a full-health bunker in one round kill it outright.
   */
  hp: number;
}

export const UNIT_DEFS = {
  launcher: { movement: 3, hp: 1 }, // spec §7: 3 hexes/round OR launch, never both
  interceptor: { movement: 0, hp: 1 }, // spec §2: static, placed at setup
  drone: { movement: 6, hp: 1 }, // spec §7: 6-hex straight-line FLIGHT, see above
  bunker: { movement: 0, hp: 2 }, // spec §7: 2 direct hits
  decoy: { movement: 0, hp: 1 }, // spec §12: identical to bunker except HP
} as const satisfies Record<UnitKind, UnitDef>;

export interface TerrainDef {
  passable: boolean;
  /** Cost to enter this tile. Not read when `passable` is false. */
  moveCost: number;
}

export const TERRAIN_DEFS = {
  plains: { passable: true, moveCost: 1 },
  urban: { passable: true, moveCost: 1 }, // spec §2: visual flavor only in V1
  mountain: { passable: false, moveCost: Infinity }, // spec §2: impassable to launchers
} as const satisfies Record<Terrain, TerrainDef>;

/**
 * Fixed spawn hexes, in map col/row offset coordinates (spec §7, §12).
 *
 * These are PUBLIC knowledge — both players know where the other's launchers
 * and drone start. `generateMap` forces all 8 to plains so a spawn can never
 * land on a mountain, and placement may never use one.
 */
export const SPAWNS = {
  p1: {
    launchers: [
      { col: 2, row: 3 },
      { col: 2, row: 7 },
      { col: 2, row: 11 },
    ],
    drone: { col: 1, row: 7 },
  },
  p2: {
    launchers: [
      { col: 16, row: 3 },
      { col: 16, row: 7 },
      { col: 16, row: 11 },
    ],
    drone: { col: 17, row: 7 },
  },
} as const satisfies Record<
  PlayerId,
  { launchers: readonly Offset[]; drone: Offset }
>;

/** Every spawn hex on the board — what `generateMap` forces to plains. */
export const ALL_SPAWN_HEXES: readonly Offset[] = [
  ...SPAWNS.p1.launchers,
  SPAWNS.p1.drone,
  ...SPAWNS.p2.launchers,
  SPAWNS.p2.drone,
];

/**
 * Round-level rules that are numbers rather than logic, kept here for the same
 * reason as the tables above: they are balance levers, not invariants.
 *
 * Enforcement lives in resolve() — most of these are order-*batch* or
 * whole-round rules that `validateMove` (one order, in isolation) structurally
 * cannot see.
 */
export const RULES = {
  /**
   * Orders a living asset may receive per round (spec §3/§9). There is no
   * separate per-round order budget — this replaces it.
   *
   * At 1 this is what makes move-XOR-launch structural: a launcher's single
   * order is either a move or a launch. It is a balance lever, not an
   * invariant, but raising it would unravel the counter-battery commitment
   * dynamic, so treat it as near-frozen.
   */
  ordersPerUnit: 1,

  /** Missile range in hexes from the firing launcher (spec §7). */
  missileRange: 6,

  /** An interceptor base covers its own hex + all hexes within this radius. */
  interceptorCoverageRadius: 1,

  /**
   * Missiles one base may destroy per round (spec §10). Drone kills are free
   * and do not consume it.
   *
   * DO NOT REMOVE CASUALLY: without this cap, a missile aimed at a base must
   * cross that base's own coverage, so bases would be unkillable and any
   * launcher parked inside a bubble permanently safe. The cap makes saturation
   * the counter, and is the stalemate-breaker for the whole design.
   */
  interceptsPerRound: 1,

  /**
   * Rounds from a drone's death to its replacement, which gives exactly one
   * full blind round in between (spec §11). Set on death, decremented at the
   * start of each order phase, respawn at 0. Respawns are unlimited.
   */
  droneRespawnDelay: 2,

  /**
   * Minimum distance from an interceptor base to its owner's bunker AND decoy
   * (spec §12 — identical rule for both, or the asymmetry would identify the
   * fake for free).
   *
   * Why it exists: without it both bases sit on top of the bunker, the drone
   * dies before it can see it, and missiles can't reach it — an unfindable,
   * unkillable turtle. The rule forces the bunker to be defended by
   * concealment and geography, never by walls.
   */
  bunkerExclusionRadius: 3,

  /** Placement zones, as inclusive col ranges in offset coords (spec §7). */
  homeZoneCols: {
    p1: { min: 0, max: 5 },
    p2: { min: 13, max: 18 },
  },

  /** Draw by Armistice when this many rounds resolve with no victory (spec §4). */
  roundCap: 25,
} as const;
