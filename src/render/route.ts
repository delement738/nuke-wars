// RENDER LAYER — the hexes a launcher's move is drawn through. Pure: no Pixi,
// no store.
//
// **The sim never picks a route** (spec §9). A move is legal when the
// destination is reachable within the budget, and resolution places the
// launcher there; nothing stores which way it went. So this file does not
// decide a rule — it picks ONE legal shortest route to draw, so that a move
// round a ridge is drawn round the ridge instead of as a straight arrow over it.
//
// What it keeps from the rules, so the picture is never impossible: mountains
// are impassable, and every hex in `blocked` (living ground units the viewer can
// see) can be neither passed through nor landed on — the same two facts
// `reachableHexes` reads. Among equally short routes it takes the one hugging
// the straight line from start to finish, so an open-ground move still reads as
// the straight arrow it always was.

import { TERRAIN_DEFS } from '../sim/defs';
import { axialToOffset, hexKey, neighbors, type Hex } from '../sim/hex';
import { tileAt, type MapData } from '../sim/map';
import type { Unit } from '../sim/types';

/** Flat-top board coordinates in hex widths — only ever compared, never drawn,
 *  so the turned P2 view (a 180° rotation) gives the same answer. */
function planar(hex: Hex): { x: number; y: number } {
  return { x: 1.5 * hex.q, y: Math.sqrt(3) * (hex.r + hex.q / 2) };
}

/** How far `hex` sits from the straight segment `a`–`b`, squared. */
function offLine(hex: Hex, a: Hex, b: Hex): number {
  const p = planar(hex);
  const s = planar(a);
  const e = planar(b);
  const dx = e.x - s.x;
  const dy = e.y - s.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / len));
  const ox = p.x - (s.x + t * dx);
  const oy = p.y - (s.y + t * dy);
  return ox * ox + oy * oy;
}

/** Steps from `from` to every reachable hex, through plains not in `blocked`. */
function stepsFrom(map: MapData, from: Hex, blocked: ReadonlySet<string>): Map<string, number> {
  const steps = new Map<string, number>([[hexKey(from), 0]]);
  let frontier: Hex[] = [from];
  for (let d = 1; frontier.length > 0; d++) {
    const next: Hex[] = [];
    for (const hex of frontier) {
      for (const n of neighbors(hex)) {
        const key = hexKey(n);
        if (steps.has(key) || blocked.has(key)) continue;
        const tile = tileAt(map, axialToOffset(n));
        if (!tile || !TERRAIN_DEFS[tile.terrain].groundPassable) continue;
        steps.set(key, d);
        next.push(n);
      }
    }
    frontier = next;
  }
  return steps;
}

/**
 * One shortest legal route from `from` to `to`, both ends included, or null if
 * none exists through what the viewer can see.
 *
 * Walked backwards from the destination: at each step, of the neighbours one
 * step nearer the start, take the one closest to the straight line. Ties fall
 * to `neighbors` order, so the same move always draws the same route.
 */
export function moveRoute(
  map: MapData,
  from: Hex,
  to: Hex,
  blocked: ReadonlySet<string> = new Set(),
): Hex[] | null {
  const steps = stepsFrom(map, from, blocked);
  let at = steps.get(hexKey(to));
  if (at === undefined) return null;

  const route: Hex[] = [to];
  let current = to;
  while (at > 0) {
    let best: Hex | null = null;
    let bestOff = Infinity;
    for (const n of neighbors(current)) {
      if (steps.get(hexKey(n)) !== at - 1) continue;
      const off = offLine(n, from, to);
      if (off < bestOff) {
        best = n;
        bestOff = off;
      }
    }
    // Unreachable: every hex with a step count has a neighbour one step nearer.
    if (!best) return null;
    route.push(best);
    current = best;
    at--;
  }
  return route.reverse();
}

/** Hexes a ground unit cannot pass through: every other living ground unit in
 *  `units`. Drones fly and block nothing (spec §2, §9). */
export function groundBlockers(units: readonly Unit[], moverId: string): Set<string> {
  const blocked = new Set<string>();
  for (const unit of units) {
    if (unit.id === moverId || unit.destroyed || unit.kind === 'drone') continue;
    blocked.add(hexKey(unit.position));
  }
  return blocked;
}

/**
 * The route to draw for a move the viewer knows happened or ordered.
 *
 * Tries round the units the viewer can see first. If they leave no way through
 * — the launcher actually went where units it cannot see, or units have moved
 * since — it routes round mountains alone, and if even that fails it falls back
 * to the bare two ends: a drawing must never refuse to show a real move.
 */
export function routeForMove(
  map: MapData,
  from: Hex,
  to: Hex,
  blocked: ReadonlySet<string>,
): Hex[] {
  return moveRoute(map, from, to, blocked) ?? moveRoute(map, from, to) ?? [from, to];
}
