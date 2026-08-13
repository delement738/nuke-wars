// CLIENT STATE — the setup screen's logic (build-order step 10b).
//
// Same discipline as `./orders`: a plain, testable module with no React in it,
// answering the questions the placement UI needs — *what is on my roster*,
// *where may this one go*, and *is my setup finished* — and answering the middle
// one by asking the real §12 validator in `src/sim/setup.ts`, never by
// re-implementing a rule.
//
// **This module hand-rolls no legality.** Every "is that allowed?" bottoms out
// in `validatePlacement` / `legalPlacementHexes`, the same functions
// `startMatch` re-checks the finished setup with. That is spec §12's requirement
// stated as code: "placement validation is a pure function in `src/sim/`, and
// the single authority both the UI and the engine call." A client-side copy
// would drift, and the first thing it would drift into is highlighting a hex the
// engine then refuses — on the one screen where a refusal has no good
// explanation, because there is no hidden information involved.
//
// Nothing here takes the opponent's setup, and nothing here could use one. The
// two home zones are disjoint row bands (§7), so there is nothing to collide
// with, and a validator that read the enemy's placements would turn the legal-hex
// highlight into a third detector (§11) — their secret sites would show up as
// holes in your own overlay (CLAUDE.md gotcha 30).
//
// **The roster is modelled as SLOTS, not as a sequence** (2026-08-13). Placement
// order is free (§12), so the player picks which of their four assets they are
// positioning; a slot is the thing they pick, and it is filled or empty rather
// than pending or done. Every function below is keyed by slot id for that
// reason, and a slot that already holds an asset can be pointed at a new hex —
// relocation and first placement are the same operation.

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

/**
 * The roster as a flat list of kinds, one entry per slot — bunker, decoy, base,
 * base (spec §7's counts, in `PLACEMENT_ORDER`).
 *
 * Everything below is indexed by position in this list, which is what a slot id
 * *is*.
 */
const ROSTER: readonly PlaceableKind[] = PLACEMENT_ORDER.flatMap((kind) =>
  Array.from({ length: RULES.placementCounts[kind] }, () => kind),
);

/** How many assets a complete setup places — 1 bunker + 1 decoy + 2 bases (§7). */
export const ROSTER_SIZE = ROSTER.length;

/**
 * The setup screen's working state: one entry per roster slot, null where the
 * asset has not been put on the board yet.
 *
 * **Slot-addressed, not a growing list**, and that is the whole point of the
 * type. `PlayerSetup` — what the sim takes — is a bare array of placements, so
 * "which of my two interceptor bases is this" is answerable only by counting
 * from the front. That is fine for the engine, which does not care, and wrong
 * for a screen where the player picked *base 2* out of a list and expects the
 * asset to appear on that row. A fixed-length draft keeps the player's choice of
 * slot; `placementSetup` throws it away at the end, once it stops mattering.
 */
export type PlacementDraft = readonly (Placement | null)[];

/** An untouched draft — every slot empty. */
export function emptyPlacementDraft(): PlacementDraft {
  return ROSTER.map(() => null);
}

/**
 * One asset on the player's roster, and where it stands if it has been placed.
 *
 * This is what the setup panel lists and what the player selects. The roster is
 * fixed — four slots, always the same four — so the list never changes shape as
 * the setup is built; only the `hex` on each entry does.
 */
export interface PlacementSlot {
  /** Index into the roster. What the UI selects by, stable for a whole match. */
  id: number;
  kind: PlaceableKind;
  /** Which one of that kind, 1-based — "base 2 of 2". */
  index: number;
  /** How many of that kind the roster holds. */
  ofKind: number;
  /** Where it stands, or null if it has not been placed yet. */
  hex: Hex | null;
}

/** The player's four roster slots, filled in from `draft`. */
export function placementSlots(draft: PlacementDraft): PlacementSlot[] {
  const soFar = new Map<PlaceableKind, number>();

  return ROSTER.map((kind, id) => {
    const n = (soFar.get(kind) ?? 0) + 1;
    soFar.set(kind, n);
    return {
      id,
      kind,
      index: n,
      ofKind: RULES.placementCounts[kind],
      hex: draft[id]?.hex ?? null,
    };
  });
}

/**
 * The draft as the `PlayerSetup` the sim takes — the placed assets, in slot
 * order, with the empty slots dropped.
 *
 * Slot order is `PLACEMENT_ORDER`, which is also the order `startingUnits` emits
 * placements in, so a setup handed to `startMatch` this way needs no further
 * sorting to keep unit order canonical (§9).
 */
export function placementSetup(draft: PlacementDraft): PlayerSetup {
  return draft.filter((entry): entry is Placement => entry !== null);
}

/** A draft holding an existing setup — how `autoPlace`'s ready-made setup gets
 *  onto the screen. Assets fill their kind's slots in the order given. */
export function placementDraftOf(setup: PlayerSetup): PlacementDraft {
  const draft: (Placement | null)[] = ROSTER.map(() => null);

  for (const placement of setup) {
    const slot = ROSTER.findIndex(
      (kind, id) => kind === placement.kind && draft[id] === null,
    );
    if (slot >= 0) draft[slot] = placement;
  }

  return draft;
}

/** Whether every slot is filled — the cue that the match may begin. */
export function placementComplete(draft: PlacementDraft): boolean {
  return nextPlacementKind(placementSetup(draft)) === null;
}

/**
 * The first empty slot, or null when the roster is full — what the UI
 * pre-selects so a player who just wants to click four times never has to
 * choose one.
 *
 * A convenience, not a rule: any slot may be selected at any time (§12, since
 * 2026-08-13).
 */
export function firstEmptySlot(draft: PlacementDraft): number | null {
  const id = draft.findIndex((entry) => entry === null);
  return id < 0 ? null : id;
}

/**
 * Everything placed EXCEPT this slot's own asset.
 *
 * The subtraction is what makes relocation work. Validating a move against the
 * whole draft would have the asset block its own new hex through the exclusion
 * rule (a base could not be nudged one hex while its old position still counted
 * as a site's neighbour) and would report ALREADY_PLACED for its own kind.
 */
function others(draft: PlacementDraft, slotId: number): PlayerSetup {
  return placementSetup(draft.map((entry, id) => (id === slotId ? null : entry)));
}

/**
 * Every hex the selected slot's asset may legally stand on — the highlight
 * overlay (§12).
 *
 * Empty for an unknown slot id, which is also what the UI wants to draw then:
 * nothing.
 */
export function placementTargets(
  map: MapData,
  player: PlayerId,
  draft: PlacementDraft,
  slotId: number,
): Hex[] {
  const kind = ROSTER[slotId];
  if (!kind) return [];
  return legalPlacementHexes(map, player, kind, others(draft, slotId));
}

/**
 * `draft` with the selected slot's asset standing on `hex` — placing it if the
 * slot was empty, moving it if it was not.
 *
 * Returns the SAME reference when that would be illegal, so a caller can tell
 * nothing happened. **An illegal placement is never stored**, which makes "every
 * setup this module produces validates" true by construction rather than by a
 * check somewhere downstream: `startMatch` throws rather than start a match on
 * an illegal board (§12), and the client must never be the reason it does.
 *
 * Writing to a fixed slot is also what keeps the roster labels honest: the asset
 * lands on the row the player picked, and moving one base never renumbers the
 * other.
 */
export function withPlacementInSlot(
  map: MapData,
  player: PlayerId,
  draft: PlacementDraft,
  slotId: number,
  hex: Hex,
): PlacementDraft {
  const kind = ROSTER[slotId];
  if (!kind) return draft;

  if (!validatePlacement(map, player, kind, hex, others(draft, slotId)).legal) {
    return draft;
  }

  const next = [...draft];
  next[slotId] = { kind, hex };
  return next;
}

/** `draft` with this slot's asset taken off the board — back to empty. Returns
 *  the same reference when the slot was empty already. */
export function withoutSlot(draft: PlacementDraft, slotId: number): PlacementDraft {
  if (draft[slotId] == null) return draft;
  const next = [...draft];
  next[slotId] = null;
  return next;
}

/** Whether this kind is a bunker site. §12's indistinguishability principle:
 *  the two are the same thing to every rule that is not about hit points. */
function isSite(kind: PlaceableKind): boolean {
  return kind === 'bunker' || kind === 'decoy';
}

/**
 * The hexes the ≥3 exclusion rule denies the selected slot (§12).
 *
 * Drawn as its own overlay, because the reason a hex is missing from the
 * highlight is the one placement rule a player cannot infer from the board:
 * everything else is visible (the zone edge, the terrain, the spawns, their own
 * assets), but "at least 3 between a base and either site" is pure rulebook. It
 * leaks nothing — these are the player's own placements — and it teaches the
 * rule that shapes the whole defensive layout: **the bunker is defended by
 * concealment and geography, never by a wall of interceptors.**
 *
 * It is computed **from the selected slot's side of the rule**, which is what
 * makes it correct in both directions now that placement order is free: choosing
 * a base shows the rings around your sites, and choosing a site shows the rings
 * around your bases.
 *
 * It deliberately does not distinguish the bunker's ring from the decoy's, and
 * returns a flat de-duplicated list so that it cannot: the rule is identical for
 * both (§12), and an overlay that drew them differently would put an asymmetry
 * on screen where the rules have none.
 */
export function exclusionHexes(
  map: MapData,
  player: PlayerId,
  draft: PlacementDraft,
  slotId: number,
): Hex[] {
  const kind = ROSTER[slotId];
  if (!kind) return [];

  const zone = RULES.homeZoneRows[player];
  const seen = new Set<string>();
  const hexes: Hex[] = [];

  for (const placement of others(draft, slotId)) {
    // Only the pairs the rule is about: one site and one base. Two bases may sit
    // side by side, and so may the bunker and the decoy.
    if (isSite(placement.kind) === isSite(kind)) continue;

    // The forbidden disc, not the legal one: an asset must be at least
    // `bunkerExclusionRadius` away, so everything strictly nearer than that —
    // radius minus one — is what is too close. Derived from the rule constant
    // rather than written as a number, so a balance pass moves the overlay with
    // the rule instead of leaving the UI quietly lying.
    for (const hex of hexesInRange(placement.hex, RULES.bunkerExclusionRadius - 1)) {
      const key = hexKey(hex);
      if (seen.has(key)) continue;
      seen.add(key);

      // Only ground the rule actually costs this player: their own home zone, on
      // the board. `hexesInRange` is pure geometry and returns hexes off the edge
      // (gotcha 37), and a ring spilling into neutral territory would draw an
      // exclusion over ground nothing could have been placed on anyway. Filtered
      // here rather than in the renderer, because which hexes to draw is a
      // question about the rules and `src/render/` is not allowed to know one.
      const offset = axialToOffset(hex);
      if (offset.row < zone.min || offset.row > zone.max) continue;
      if (!tileAt(map, offset)) continue;

      hexes.push(hex);
    }
  }

  return hexes;
}
