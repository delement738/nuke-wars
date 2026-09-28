// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// Missiles: launch validation, flight geometry, and interception adjudication
// (spec §10; build-order step 6). Same split as movement.ts and recon.ts — this
// module answers questions and computes outcomes; resolve() applies them to the
// board, updates intel, and emits events.
//
// The three rules that shape everything here:
//   - a LAUNCH may not cross a mountain, but may TARGET one (§10, amended
//     2026-09-28). `lineOfFireClear` checks the hexes strictly between origin
//     and target, once, at launch. The target hex is exempt because filtering
//     targets by terrain would make a bunker built on a mountain (§12)
//     literally invulnerable. Flight itself never reads terrain.
//   - a missile is checked for interception on every hex AFTER its origin,
//     target hex included — `hexLine(...).slice(1)` (§10). Keeping the origin in
//     would let a launcher be shot down by a base covering its own hex, which
//     is the launcher's own side of the board.
//   - a missile advances `RULES.missileSpeed` hexes per round (§10), so a long
//     shot spends a round in flight and is carried in `GameState.missiles`.
//   - each base destroys at most `RULES.interceptsPerRound` missiles per round
//     (§10). That cap is the stalemate-breaker for the whole design: without it
//     a base is unkillable, because any missile aimed at one must cross its
//     coverage to get there. Saturation is the counter.

import { basesCovering } from './coverage';
import { RULES } from './defs';
import {
  axialToOffset,
  compareHex,
  distance,
  hexKey,
  hexLine,
  type Hex,
} from './hex';
import { lineOfFireClear, tileAt } from './map';
import type {
  GameState,
  LaunchOrder,
  Missile,
  MissileId,
  PlayerId,
  Unit,
  UnitId,
} from './types';

/**
 * Why a LAUNCH order was rejected.
 *
 * Note what is *absent*: there is no target-terrain reason and no
 * occupied-tile reason. Blind fire at any hex on the map within range and with
 * a clear line is legal (§3) — a mountain, open plains, a hex holding your own
 * launcher, all of it. `LINE_BLOCKED` is about the hexes the shot CROSSES,
 * never the one it lands on: filtering targets by terrain is the one mistake
 * §10 calls out by name.
 *
 * `NOT_A_LAUNCHER` completes the set movement.ts's `AIR_UNIT` and recon.ts's
 * `NOT_AIR_UNIT` began: each order kind rejects the wrong sort of unit with a
 * reason that names the category error, instead of letting it look like a range
 * problem.
 */
export type LaunchIllegalReason =
  | 'UNKNOWN_UNIT' // no unit in the game carries that id
  | 'NOT_YOUR_UNIT' // belongs to the other player
  | 'NOT_A_LAUNCHER' // only launchers fire; nothing else has a missile
  | 'UNIT_DESTROYED' // already dead; wrecks don't shoot
  | 'SAME_HEX' // §3: the target may not be the launcher's own hex
  | 'OFF_MAP' // target isn't a real tile
  | 'OUT_OF_RANGE' // straight-line distance exceeds RULES.missileRange
  | 'LINE_BLOCKED'; // a mountain strictly between origin and target (§10)

export type LaunchValidation =
  | { legal: true; distance: number }
  | { legal: false; reason: LaunchIllegalReason };

/** A missile destroyed in flight, the hex it was destroyed over, and by whom. */
export interface Interception {
  missile: Missile;
  hex: Hex;
  /**
   * The base that spent its intercept. Engine bookkeeping only — resolve() uses
   * it to expose the base to the enemy (`BASE_EXPOSED`, spec §10), and no event
   * ever carries its id.
   */
  base: Unit;
}

export interface MissileFlights {
  /**
   * Missiles that reached their target hex this round, in canonical order —
   * phase 3's input. `traveled === path.length` on every one.
   */
  arrived: Missile[];
  /**
   * Missiles still short of their target after this round's advance, in
   * canonical order, with `traveled` updated — the next `GameState.missiles`.
   */
  inFlight: Missile[];
  /**
   * Missiles shot down, in the order it happened: by flight step first, then by
   * canonical order within a step. Chronological, so a client can animate
   * straight from the log.
   */
  interceptions: Interception[];
}

/**
 * The per-round id shared by a missile's `LAUNCH_DETECTED`, `MISSILE_INTERCEPTED`
 * and `IMPACT` events (spec §6).
 *
 * Built from the round number and the origin hex — both public the instant
 * `LAUNCH_DETECTED` fires — so it lets a client tell which missile an event
 * belongs to while leaking nothing about which launcher fired it. A launcher
 * fires at most one missile per round (`RULES.ordersPerUnit`) and no two ground
 * units share a hex (§9), so it is unique within the round.
 *
 * NEVER derive this from a unit id. That would hand the enemy a trackable
 * identity, which §11 withholds by design — it is the reason intel is keyed by
 * hex rather than by unit.
 */
export function missileIdFor(round: number, origin: Hex): MissileId {
  return `r${round}@${hexKey(origin)}`;
}

/**
 * Whether `playerId` may issue this LAUNCH order against the *full* game state.
 *
 * Like a FLY order and unlike a MOVE, every rejection here is derivable from
 * information the ordering player already holds: their own launcher's position
 * and kind, the missile's range, and the public map (§11). Hidden information
 * can never cause one, so resolve() drops a rejected LAUNCH in silence — there
 * is no `MOVE_FAILED` counterpart, for §9's reasons applied to the air.
 *
 * Blind fire is the norm, not the exception: the target hex need not contain
 * anything the player can see, or anything at all (§3).
 */
export function validateLaunch(
  state: GameState,
  playerId: PlayerId,
  order: LaunchOrder,
): LaunchValidation {
  const unit = state.units.find((u) => u.id === order.unitId);
  if (!unit) return { legal: false, reason: 'UNKNOWN_UNIT' };
  if (unit.owner !== playerId) return { legal: false, reason: 'NOT_YOUR_UNIT' };
  if (unit.kind !== 'launcher') return { legal: false, reason: 'NOT_A_LAUNCHER' };
  if (unit.destroyed) return { legal: false, reason: 'UNIT_DESTROYED' };

  if (hexKey(order.target) === hexKey(unit.position)) {
    return { legal: false, reason: 'SAME_HEX' };
  }

  if (!tileAt(state.map, axialToOffset(order.target))) {
    return { legal: false, reason: 'OFF_MAP' };
  }

  // Straight-line distance, with NO terrain-aware path cost anywhere near it:
  // a missile flies over units and over the whole ground layer's notion of
  // "reachable" (§10).
  const flown = distance(unit.position, order.target);
  if (flown > RULES.missileRange) {
    return { legal: false, reason: 'OUT_OF_RANGE' };
  }

  // Line of fire (§10, 2026-09-28): no mountain strictly between. Checked here,
  // at launch, and nowhere in `flyMissiles` — a missile in the air has a fixed
  // path. Terrain is public, so like every rejection above this one is
  // derivable by the sender and is dropped in silence.
  if (!lineOfFireClear(state.map, unit.position, order.target)) {
    return { legal: false, reason: 'LINE_BLOCKED' };
  }

  return { legal: true, distance: flown };
}

/**
 * Build the missile a validated LAUNCH puts in the air.
 *
 * The `slice(1)` is load-bearing and is the one place it may happen: the origin
 * hex is not an interception step, or a launcher parked inside a friendly
 * bubble would be shooting through its own coverage (§10). `recon.ts` slices
 * the same primitive the other way — the drone's swath keeps its start hex —
 * which is why neither caller may re-derive a line for itself.
 */
export function createMissile(round: number, launcher: Unit, target: Hex): Missile {
  return {
    id: missileIdFor(round, launcher.position),
    owner: launcher.owner,
    launcherId: launcher.id,
    origin: launcher.position,
    target,
    path: hexLine(launcher.position, target).slice(1),
    launchRound: round,
    traveled: 0,
  };
}

/**
 * The order simultaneous missiles are adjudicated and logged in: oldest launch
 * round first, then by origin hex, `q` then `r` (spec §10, amended 2026-08-11;
 * the launch-round key added with flight time, 2026-09-27).
 *
 * Both keys are public — the missile id publishes them — so the ordering a
 * player can observe in the log tells them nothing they were not handed. Two
 * missiles never tie on both: a hex fires at most once per round.
 *
 * Some fixed sequence is unavoidable — when two missiles enter one base's
 * coverage on the same step, exactly one can be engaged — and it has to come
 * from somewhere neither client controls, or the outcome would depend on how a
 * UI happened to sort its submission (§6).
 *
 * §10 originally specified the firing launcher's unit id. That was changed
 * because the ordering is publicly observable and unit ids are not supposed to
 * be: with two launches in a round, the log's order would tell the defender
 * which of two enemy launcher ids sorts first, and a few rounds of that
 * reconstructs the ordering of all three — enough to link "the same launcher"
 * across rounds. §11 keys every scrap of intel by hex precisely to make that
 * impossible, and §6 already forbids deriving missile ids from unit ids for the
 * same reason. The origin hex is public the moment `LAUNCH_DETECTED` fires, so
 * ordering by it is exactly as arbitrary, exactly as deterministic, and tells
 * the enemy nothing they were not already handed.
 *
 * Bases keep the id tiebreak (`basesCovering` in coverage.ts): they belong to
 * the defender, no event names one, and they cannot move.
 */
export function canonicalOrder(missiles: readonly Missile[]): Missile[] {
  return [...missiles].sort(
    (a, b) => a.launchRound - b.launchRound || compareHex(a.origin, b.origin),
  );
}

/**
 * Advance every missile in the air by up to `RULES.missileSpeed` hexes,
 * simultaneously, and adjudicate interception (spec §10).
 *
 * `missiles` is everything aloft this round: the ones fired in phase 2 and the
 * ones carried over in `GameState.missiles`, together. They are all one volley
 * as far as the defence is concerned.
 *
 * The missiles advance **step by step together**, not one flight at a time, and
 * the difference is a real rule rather than an implementation detail: a base
 * with one intercept left engages whichever missile reaches it *first*, so a
 * missile two hexes out cannot be saved by another missile that would only have
 * arrived later. Resolving flight-by-flight would silently award the intercept
 * to whichever missile the array happened to list first. A carried missile
 * simply starts its steps from `traveled` rather than from its origin.
 *
 * Each path hex is checked **once, on entry, over the missile's whole life**.
 * A missile that ends a round parked inside a bubble is not re-engaged over the
 * hex it is sitting on; it meets the base again only on the next hex it enters.
 *
 * Capacity is spent per base and lasts the round (`RULES.interceptsPerRound`).
 * A missile crossing several bubbles is engaged by whichever base still has
 * capacity when it enters — which is what makes a saturating volley through one
 * lane the counter to interceptor geometry, and why the cap must not be
 * removed casually. Because capacity resets each round while a long flight
 * spans two, saturation also has a time axis: a bubble can be walked through.
 *
 * Drone kills are NOT adjudicated here and never consume capacity (§2, §10);
 * they are settled in phase 1 by `flyDrone`, using the same coverage module.
 *
 * `units` is the board as phase 2 found it: a base destroyed in an earlier round
 * covers nothing, but a base destroyed by *this* round's impacts (phase 3) still
 * defends, because it was alive when the missiles crossed it.
 */
export function flyMissiles(
  units: readonly Unit[],
  missiles: readonly Missile[],
): MissileFlights {
  const ordered = canonicalOrder(missiles);

  // Capacity is created lazily per base, so a base that never engages anything
  // never appears here. Keyed by base id — the defender's own identity, which is
  // safe to sort on (see canonicalOrder).
  const capacity = new Map<UnitId, number>();
  const downed = new Set<MissileId>();
  const traveled = new Map(ordered.map((m) => [m.id, m.traveled]));
  const interceptions: Interception[] = [];

  for (let step = 0; step < RULES.missileSpeed; step++) {
    for (const missile of ordered) {
      if (downed.has(missile.id)) continue;

      // A missile that has already reached its target has no hex at this step —
      // arrival is phase 3's business.
      const done = traveled.get(missile.id) ?? missile.traveled;
      const hex = missile.path[done];
      if (!hex) continue;
      traveled.set(missile.id, done + 1);

      for (const base of basesCovering(units, hex, missile.owner)) {
        const left = capacity.get(base.id) ?? RULES.interceptsPerRound;
        if (left <= 0) continue;

        capacity.set(base.id, left - 1);
        downed.add(missile.id);
        interceptions.push({ missile, hex, base });
        break;
      }
    }
  }

  const arrived: Missile[] = [];
  const inFlight: Missile[] = [];
  for (const missile of ordered) {
    if (downed.has(missile.id)) continue;
    const advanced = { ...missile, traveled: traveled.get(missile.id) ?? missile.traveled };
    (advanced.traveled >= advanced.path.length ? arrived : inFlight).push(advanced);
  }

  return { arrived, inFlight, interceptions };
}

/**
 * Total hits landing on each hex this round, keyed by `hexKey` (spec §3).
 *
 * Hits STACK: two missiles on one hex deal 2, which is what lets a 2-missile
 * alpha strike destroy a full-health bunker in a single round and skip the
 * decoy test (§12). Applying one hit per hex would quietly make the real bunker
 * unkillable in fewer than two rounds, and the alpha strike is a deliberate
 * (expensive) option, not an exploit.
 *
 * Damage is per HEX, not per target, because a missile is aimed at ground and
 * hits whatever is standing there — friendly, enemy, or nothing at all.
 */
export function damageByHex(arrived: readonly Missile[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const missile of arrived) {
    const key = hexKey(missile.target);
    totals.set(key, (totals.get(key) ?? 0) + RULES.missileDamage);
  }
  return totals;
}
