// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// Interceptor coverage geometry (spec §10). A base covers its own hex plus
// every hex within `RULES.interceptorCoverageRadius` — radius 1, so 7 hexes.
//
// This is its own module because two resolution phases read the same rule from
// opposite ends. The recon phase (build-order step 5) asks "does an enemy base
// cover this hex?", because a drone dies the instant it *enters* one. The launch
// phase (step 6) will ask the same question of every hex on a missile's path,
// and additionally needs the covering bases themselves so it can spend each
// base's single missile intercept for the round.
//
// The parameter is the **viewer**, never the base's owner, and only bases the
// viewer does not own are ever considered. That is spec §10's "friendly missiles
// and the owner's own drone are never engaged" expressed as a signature rather
// than as a rule to remember: there is no way to ask this module about a
// friendly base, so no caller can shoot down its own drone by passing the wrong
// player id.
//
// Coverage carries no capacity bookkeeping. The per-round cap
// (`RULES.interceptsPerRound`) belongs to the caller, because it governs
// missiles only — drone kills are free and never consume it (spec §2, §10).

import { RULES } from './defs';
import { distance, type Hex } from './hex';
import type { PlayerId, Unit } from './types';

/** Whether `base` covers `hex`. Pure geometry — assumes `base` is a live base. */
function covers(base: Unit, hex: Hex): boolean {
  return distance(base.position, hex) <= RULES.interceptorCoverageRadius;
}

/**
 * A living interceptor base belonging to the viewer's opponent.
 *
 * Destroyed bases cover nothing: a base that died in an earlier round leaves no
 * bubble behind, which is what makes killing one worth a missile.
 */
function isLiveEnemyBase(unit: Unit, viewer: PlayerId): boolean {
  return (
    unit.kind === 'interceptor' && !unit.destroyed && unit.owner !== viewer
  );
}

/**
 * Whether any base hostile to `viewer` covers `hex` (spec §10).
 *
 * This is the whole of the drone-kill rule: a drone entering a hex for which
 * this returns true is destroyed, no capacity is consumed, and no further check
 * is needed. Missiles need to know *which* base engaged them — that is
 * `basesCovering` below.
 */
export function isCoveredByEnemy(
  units: readonly Unit[],
  hex: Hex,
  viewer: PlayerId,
): boolean {
  return units.some((unit) => isLiveEnemyBase(unit, viewer) && covers(unit, hex));
}

/**
 * Every base hostile to `viewer` that covers `hex`, in ascending base-id order
 * (spec §10; build-order step 6).
 *
 * The missile counterpart of `isCoveredByEnemy`. A missile needs the bases
 * themselves rather than a yes/no, because each base may destroy only
 * `RULES.interceptsPerRound` missiles per round and the caller has to know whose
 * capacity to spend. A drone kill needs none of that — it is free and uncapped —
 * which is why the boolean above stays.
 *
 * The sort is spec §10's second tiebreak: "one missile entering two bases'
 * coverage at once — bases by base id." Unlike the missile-side tiebreak (which
 * is ordered by origin hex, see `missiles.ts`), sorting bases by id leaks
 * nothing. A base belongs to the defender, who already knows their own ids;
 * `MISSILE_INTERCEPTED` never names one; and a base cannot move, so there is no
 * cross-round identity to track (§6, §11).
 */
export function basesCovering(
  units: readonly Unit[],
  hex: Hex,
  viewer: PlayerId,
): Unit[] {
  return units
    .filter((unit) => isLiveEnemyBase(unit, viewer) && covers(unit, hex))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
