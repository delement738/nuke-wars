// CLIENT STATE — the setup screen's logic (build-order step 10b).
//
// Same discipline as `./orders`: a plain, testable module with no React in it,
// answering the three questions the placement UI needs — *what am I placing
// now*, *where may it go*, and *what does my setup add up to* — and answering
// the middle one by asking the real §12 validator in `src/sim/setup.ts`, never
// by re-implementing a rule.
//
// **This module hand-rolls no legality.** Every "is that allowed?" bottoms out
// in `validatePlacement` / `legalPlacementHexes` / `nextPlacementKind`, the same
// functions `startMatch` re-checks the finished setup with. That is spec §12's
// requirement stated as code: "placement validation is a pure function in
// `src/sim/`, and the single authority both the UI and the engine call." A
// client-side copy would drift, and the first thing it would drift into is
// highlighting a hex the engine then refuses — on the one screen where a refusal
// has no good explanation, because there is no hidden information involved.
//
// Nothing here takes the opponent's setup, and nothing here could use one. The
// two home zones are disjoint row bands (§7), so there is nothing to collide
// with, and a validator that read the enemy's placements would turn the legal-hex
// highlight into a third detector (§11) — their secret sites would show up as
// holes in your own overlay (CLAUDE.md gotcha 30).

import { RULES, type PlaceableKind } from '../sim/defs';
import { axialToOffset, hexKey, hexesInRange, type Hex } from '../sim/hex';
import { tileAt, type MapData } from '../sim/map';
import {
  PLACEMENT_ORDER,
  legalPlacementHexes,
  nextPlacementKind,
  validatePlacement,
  type Placement,
  type PlayerSetup,
} from '../sim/setup';
import type { PlayerId } from '../sim/types';

/** How many assets a complete setup places — 1 bunker + 1 decoy + 2 bases (§7). */
export const ROSTER_SIZE: number = PLACEMENT_ORDER.reduce(
  (total, kind) => total + RULES.placementCounts[kind],
  0,
);

/**
 * Where a player is in their placement sequence — everything a progress line
 * ("Interceptor base 2 of 2 — step 4 of 4") needs, computed once.
 *
 * Null when the roster is complete, which is the same answer the UI wants: there
 * is nothing left to place, so start the match.
 */
export interface PlacementStep {
  /** The kind being placed now. */
  kind: PlaceableKind;
  /** Which one of that kind, 1-based — "base 2 of 2". */
  index: number;
  /** How many of that kind the roster holds. */
  ofKind: number;
  /** Which placement overall, 1-based — "step 4 of 4". */
  ordinal: number;
}

/** What `placed` must place next, or null when the setup is complete (§12). */
export function placementStep(placed: PlayerSetup): PlacementStep | null {
  const kind = nextPlacementKind(placed);
  if (kind === null) return null;

  return {
    kind,
    index: placed.filter((p) => p.kind === kind).length + 1,
    ofKind: RULES.placementCounts[kind],
    ordinal: placed.length + 1,
  };
}

/** Whether every slot in the roster is filled — the cue to start the match. */
export function placementComplete(placed: PlayerSetup): boolean {
  return nextPlacementKind(placed) === null;
}

/**
 * Every hex the current step may legally use — the highlight overlay (§12).
 *
 * Returns empty when the setup is complete, because there is no current step;
 * that is also what the UI wants to draw at that point, which is nothing.
 */
export function placementTargets(
  map: MapData,
  player: PlayerId,
  placed: PlayerSetup,
): Hex[] {
  const step = placementStep(placed);
  if (!step) return [];
  return legalPlacementHexes(map, player, step.kind, placed);
}

/**
 * `placed` with `hex` taken by the current step — or unchanged (the same
 * reference, so a caller can tell nothing happened) if that placement is
 * illegal.
 *
 * **An illegal placement is never stored**, which is what makes "every setup
 * this module produces validates" true by construction rather than by a check
 * somewhere downstream — `startMatch` throws rather than start a match on an
 * illegal board (§12), and the client should never be the reason it does.
 */
export function withPlacement(
  map: MapData,
  player: PlayerId,
  placed: PlayerSetup,
  hex: Hex,
): PlayerSetup {
  const step = placementStep(placed);
  if (!step) return placed;
  if (!validatePlacement(map, player, step.kind, hex, placed).legal) return placed;

  const placement: Placement = { kind: step.kind, hex };
  return [...placed, placement];
}

/** `placed` with its most recent placement taken back, for the Undo button. */
export function withoutLastPlacement(placed: PlayerSetup): PlayerSetup {
  return placed.length === 0 ? placed : placed.slice(0, -1);
}

/**
 * The hexes inside `RULES.bunkerExclusionRadius` of a site the player has
 * already placed — the ground their interceptor bases may not stand on (§12).
 *
 * Drawn as its own overlay while the bases are being placed, because the reason
 * a hex is missing from the highlight is the one placement rule a player cannot
 * infer from the board: everything else is visible (the zone edge, the terrain,
 * the spawn hexes, their own sites), but "at least 3 from both of your sites" is
 * pure rulebook. It leaks nothing — these are the player's own placements — and
 * it teaches the rule that shapes the whole defensive layout: **the bunker is
 * defended by concealment and geography, never by a wall of interceptors.**
 *
 * It deliberately does not distinguish the bunker's ring from the decoy's. The
 * rule is identical for both (§12's indistinguishability principle) and drawing
 * them differently would put an asymmetry on screen where the rules have none.
 * Returned as a flat, de-duplicated list for that reason: the two rings overlap,
 * and which site a hex was excluded by is not a fact the UI should be able to
 * show.
 */
export function exclusionHexes(
  map: MapData,
  player: PlayerId,
  placed: PlayerSetup,
): Hex[] {
  const sites = placed.filter((p) => p.kind === 'bunker' || p.kind === 'decoy');
  const zone = RULES.homeZoneRows[player];
  const seen = new Set<string>();
  const hexes: Hex[] = [];

  for (const site of sites) {
    // The forbidden disc, not the legal one: a base must be at least
    // `bunkerExclusionRadius` away, so everything strictly nearer than that —
    // radius minus one — is what is too close. Derived from the rule constant
    // rather than written as a number, so a balance pass moves the overlay with
    // the rule instead of leaving the UI quietly lying.
    for (const hex of hexesInRange(site.hex, RULES.bunkerExclusionRadius - 1)) {
      const key = hexKey(hex);
      if (seen.has(key)) continue;
      seen.add(key);

      // Only ground the rule actually costs this player: their own home zone,
      // on the board. `hexesInRange` is pure geometry and returns hexes off the
      // edge (gotcha 37), and a ring spilling into neutral territory would draw
      // an exclusion over ground no base could have used anyway. Filtered here
      // rather than in the renderer, because which hexes to draw is a question
      // about the rules and `src/render/` is not allowed to know one.
      const offset = axialToOffset(hex);
      if (offset.row < zone.min || offset.row > zone.max) continue;
      if (!tileAt(map, offset)) continue;

      hexes.push(hex);
    }
  }

  return hexes;
}
