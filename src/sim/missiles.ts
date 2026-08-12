// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// Missiles: launch validation, flight geometry, and interception adjudication
// (spec §10; build-order step 6). Same split as movement.ts and recon.ts — this
// module answers questions and computes outcomes; resolve() applies them to the
// board, updates intel, and emits events.
//
// The three rules that shape everything here:
//   - a missile IGNORES TERRAIN, in flight and in targeting (§10). There is no
//     passability check anywhere in this file, and adding one would make a
//     bunker built on a mountain (§12) literally invulnerable.
//   - a missile is checked for interception on every hex AFTER its origin,
//     target hex included — `hexLine(...).slice(1)` (§10). Keeping the origin in
//     would let a launcher be shot down by a base covering its own hex, which
//     is the launcher's own side of the board.
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
import { tileAt } from './map';
import type {
  GameState,
  LaunchOrder,
  MissileId,
  PlayerId,
  Unit,
  UnitId,
} from './types';

/**
 * Why a LAUNCH order was rejected.
 *
 * Note what is *absent*: there is no impassable-terrain reason and no
 * occupied-tile reason. Blind fire at any hex on the map within range is legal
 * (§3) — a mountain, open plains, a hex holding your own launcher, all of it.
 * Filtering targets by terrain is the one mistake §10 calls out by name.
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
  | 'OUT_OF_RANGE'; // straight-line distance exceeds RULES.missileRange

export type LaunchValidation =
  | { legal: true; distance: number }
  | { legal: false; reason: LaunchIllegalReason };

/**
 * One missile, in flight for one round.
 *
 * Missiles are never stored in `GameState`: they are created in phase 2, fly,
 * and either die to interception or land in phase 3, all inside a single
 * `resolve()` call. Nothing about them survives the round, which is why they are
 * a plain value here rather than a `Unit`.
 */
export interface Missile {
  /** See `missileIdFor` — derived from public data only (§6). */
  id: MissileId;
  owner: PlayerId;
  /**
   * The firing launcher. Kept so phase 3 can attribute nothing to it and phase 2
   * can leave it out of every event — it is deliberately NOT part of `id`, and
   * no event ever carries it. It exists for the engine's own bookkeeping.
   */
  launcherId: UnitId;
  origin: Hex;
  target: Hex;
  /**
   * Every hex after the origin, with the target hex last (`hexLine.slice(1)`,
   * §10). This is the interception check list, in flight order.
   */
  path: Hex[];
}

/** A missile destroyed in flight, and the hex it was destroyed over. */
export interface Interception {
  missile: Missile;
  hex: Hex;
}

export interface MissileFlights {
  /** Missiles that reached their target hex, in canonical order. */
  survivors: Missile[];
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
  // a missile flies over mountains, over units, and over the whole ground
  // layer's notion of "reachable" (§10).
  const flown = distance(unit.position, order.target);
  if (flown > RULES.missileRange) {
    return { legal: false, reason: 'OUT_OF_RANGE' };
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
  };
}

/**
 * The order simultaneous missiles are adjudicated and logged in: by origin hex,
 * `q` then `r` (spec §10, amended 2026-08-11).
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
  return [...missiles].sort((a, b) => compareHex(a.origin, b.origin));
}

/**
 * Fly every missile simultaneously and adjudicate interception (spec §10).
 *
 * The missiles advance **step by step together**, not one flight at a time, and
 * the difference is a real rule rather than an implementation detail: a base
 * with one intercept left engages whichever missile reaches it *first*, so a
 * missile two hexes out cannot be saved by another missile that would only have
 * arrived later. Resolving flight-by-flight would silently award the intercept
 * to whichever missile the array happened to list first.
 *
 * Capacity is spent per base and lasts the round (`RULES.interceptsPerRound`).
 * A missile crossing several bubbles is engaged by whichever base still has
 * capacity when it enters — which is what makes a saturating volley through one
 * lane the counter to interceptor geometry, and why the cap must not be
 * removed casually.
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
  const interceptions: Interception[] = [];

  const longest = ordered.reduce((max, m) => Math.max(max, m.path.length), 0);

  for (let step = 0; step < longest; step++) {
    for (const missile of ordered) {
      if (downed.has(missile.id)) continue;

      // Short flights simply have no hex at this step — they have already
      // arrived, and arrival is phase 3's business.
      const hex = missile.path[step];
      if (!hex) continue;

      for (const base of basesCovering(units, hex, missile.owner)) {
        const left = capacity.get(base.id) ?? RULES.interceptsPerRound;
        if (left <= 0) continue;

        capacity.set(base.id, left - 1);
        downed.add(missile.id);
        interceptions.push({ missile, hex });
        break;
      }
    }
  }

  return {
    survivors: ordered.filter((missile) => !downed.has(missile.id)),
    interceptions,
  };
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
export function damageByHex(survivors: readonly Missile[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const missile of survivors) {
    const key = hexKey(missile.target);
    totals.set(key, (totals.get(key) ?? 0) + RULES.missileDamage);
  }
  return totals;
}
