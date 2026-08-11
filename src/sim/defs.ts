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

/**
 * The asset kinds a player places during SETUP (spec §12). Launchers and the
 * drone are absent because they are not placed — they start on the fixed public
 * spawn hexes in `SPAWNS`, and their terrain restriction is enforced by
 * movement (`TerrainDef.groundPassable`), not by a placement rule.
 */
export type PlaceableKind = Extract<
  UnitKind,
  'bunker' | 'decoy' | 'interceptor'
>;

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
   * is its ratio to missile range (6) and the length of the north/south axis
   * the two sides advance along (map height 19, 14 rows between the opposing
   * spawn lines). At 3, a launcher gets roughly two rounds of maneuver before
   * first contact, and cannot
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
  /**
   * Whether a GROUND unit may enter this tile.
   *
   * Named `groundPassable` rather than the obvious `passable` because that
   * shorter name now answers the wrong question. Static structures are *built*,
   * not driven: a mountain stops a launcher, but a bunker, decoy or interceptor
   * base may sit on one (spec §12) — it is still overflown by recon and still
   * reachable by missiles. Anything asking "may this be *built* here?" must read
   * `RULES.placementTerrain`; this flag answers only "may this be *entered*?".
   */
  groundPassable: boolean;
  /** Cost to enter this tile. Not read when `groundPassable` is false. */
  moveCost: number;
}

/**
 * V1 has exactly two terrains (spec §2). `moveCost` is therefore always 1 in
 * practice — the flood fill in movement.ts still reads it rather than assuming,
 * so a future third terrain is a data edit here and not an algorithm change.
 */
export const TERRAIN_DEFS = {
  plains: { groundPassable: true, moveCost: 1 },
  mountain: { groundPassable: false, moveCost: Infinity }, // spec §2: launchers only
} as const satisfies Record<Terrain, TerrainDef>;

/**
 * Mountain generation tuning (spec §7). Lives here rather than in `map.ts` for
 * the same reason as every other table in this file: it is a balance lever, and
 * a terrain pass should be a one-file diff.
 *
 * Mountains are grown as **ranges**, not rolled per hex. That distinction is
 * load-bearing, not cosmetic: scattered singletons at 15% are speed bumps a
 * launcher walks around without noticing, while 15% in ridges is walls,
 * chokepoints, and detours. The validation constants below exist because
 * ridges — unlike noise — can produce a map nobody can cross.
 */
export const TERRAIN_GEN = {
  /** Share of the board that is mountain. Ranges grow until this is hit. */
  mountainFraction: 0.15,

  /** Band every seed must land inside, asserted across seeds by map.test.ts. */
  mountainFractionBand: { min: 0.1, max: 0.2 },

  /** Ridges grown per generated half; the other half is their half-turn image. */
  rangesPerHalf: 4,

  /** Chance a growing ridge keeps its heading rather than veering (0–1). */
  rangeStraightness: 0.7,

  /**
   * Hexes around every spawn kept mountain-free. Forcing the spawn hex itself
   * to plains is NOT enough once mountains cluster: a plains hex ringed by a
   * ridge is a launcher immobilised for the whole match.
   */
  spawnClearanceRadius: 1,

  /**
   * Ground-travel cost from a launcher spawn to the nearest hex from which it
   * could hit an enemy launcher spawn (i.e. within `RULES.missileRange` of one).
   *
   * On a mountain-free board this is 8 — the 14 rows between the launcher lines
   * less the missile's 6 — which at movement 3 is the "~2 rounds of maneuver,
   * first blood around round 3" premise §7 is tuned on. 12 permits roughly one
   * extra round of detour; beyond that the premise stops holding and the map is
   * re-rolled rather than shipped.
   */
  maxApproachCost: 12,

  /**
   * Re-roll attempts before `generateMap` throws. Failing loudly beats shipping
   * a map with a boxed-in launcher — and since a wall would have to span all 16
   * columns, retries should be vanishingly rare. If this ever throws in
   * practice, the generation constants above have drifted, not the validator.
   */
  maxAttempts: 20,
} as const;

/**
 * Fixed spawn hexes, in map col/row offset coordinates (spec §7, §12).
 *
 * The board is fought north/south: **P1 holds the south (high row numbers) and
 * advances north; P2 holds the north (row 0 is the top of the screen) and
 * advances south.** Row 16 is two rows in from P1's edge, row 2 two rows in
 * from P2's — 14 rows of ground between the two launcher lines.
 *
 * These are PUBLIC knowledge — both players know where the other's launchers
 * and drone start. `generateMap` forces all 8 to plains so a spawn can never
 * land on a mountain, and placement may never use one.
 *
 * Each P1 spawn's half-turn image (`rotate180`) is itself a listed P2 spawn,
 * which is what lets `generateMap` force spawns to plains after the copy pass
 * without breaking the map's symmetry — `map.test.ts` pins that pairing down.
 * The columns are not identical between the two sides because the symmetry is
 * a rotation, not a mirror: P1's launcher at col 2 answers P2's at col 13.
 */
export const SPAWNS = {
  p1: {
    launchers: [
      { col: 2, row: 16 },
      { col: 8, row: 16 },
      { col: 13, row: 16 },
    ],
    drone: { col: 8, row: 17 },
  },
  p2: {
    launchers: [
      { col: 2, row: 2 },
      { col: 7, row: 2 },
      { col: 13, row: 2 },
    ],
    drone: { col: 7, row: 1 },
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
   * How far to either side of its flight path the drone photographs (spec §11).
   * At 1 the swath is the classic "3 wide" corridor: every hex the drone safely
   * traverses, plus that hex's 6 neighbours.
   *
   * READ THIS BEFORE TUNING EITHER RADIUS — the two interact in a way that is
   * invisible in the numbers. While this is <= `interceptorCoverageRadius`, a
   * drone can never photograph an interceptor base: any base close enough to
   * fall inside the swath is, by the same distance, covering a hex the drone
   * must enter to get it — so the drone is destroyed one step before the
   * picture is taken (verified by brute force over every flight geometry).
   * Bases are then findable only by *inference* from the public 7-candidate
   * clues, `MISSILE_INTERCEPTED` and `DRONE_DOWNED`.
   *
   * Raising this to 2 is the one-number change that makes §12's "finding
   * interceptor bases narrows the bunker hunt" true: the drone could then fly
   * past at distance 2, outside the bubble, and still see the base. It also
   * widens every other reveal from a 3-wide corridor to a 5-wide one, which is
   * a large buff to recon overall — hence a playtest decision, not a bug fix.
   */
  reconSwathRadius: 1,

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

  /**
   * Placement zones, as inclusive ROW ranges in offset coords (spec §7).
   *
   * The board is fought north/south, so a home zone is a 6-row band across the
   * full 16-column width: P1's is the south edge, P2's the north, with 7 rows
   * of neutral ground (6–12) between them.
   */
  homeZoneRows: {
    p1: { min: 13, max: 18 },
    p2: { min: 0, max: 5 },
  },

  /**
   * How many of each asset a player places during SETUP (spec §7, §12).
   * Launcher and drone counts are not here because they are not placed — they
   * start on the fixed public spawn hexes in SPAWNS.
   *
   * Placement order is bunker -> decoy -> bases, and every count here is
   * validated by the same pure function the UI calls, so the two can never
   * disagree about what a legal setup is.
   */
  placementCounts: {
    bunker: 1,
    decoy: 1,
    interceptor: 2,
  } as const satisfies Record<PlaceableKind, number>,

  /**
   * Terrain each placed asset may be built on (spec §12).
   *
   * Static structures are built, not driven, so terrain that stops a launcher
   * does not stop construction: a bunker on a mountain is still overflown by
   * recon, still marked permanently once spotted, and still destroyed by two
   * missiles. What it gains is immunity to ground probing — an enemy launcher
   * cannot be ordered into a mountain hex at all, so it can never bump into a
   * site there (§9, §11). What it pays is a much narrower search: terrain is
   * public, so the enemy knows exactly which hexes those are.
   *
   * **bunker and decoy MUST stay identical** — §12's indistinguishability
   * principle. If the decoy were barred from terrain the bunker allowed, every
   * site found on that terrain would be provably the real one and the bluff
   * would be worth nothing. `defs.test.ts` asserts the two lists are equal so a
   * balance pass cannot break it by editing one row and forgetting the other.
   */
  placementTerrain: {
    bunker: ['plains', 'mountain'],
    decoy: ['plains', 'mountain'],
    interceptor: ['plains', 'mountain'],
  } as const satisfies Record<PlaceableKind, readonly Terrain[]>,

  /** Draw by Armistice when this many rounds resolve with no victory (spec §4). */
  roundCap: 25,
} as const;
