// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// Secret placement and the opening state — spec §12 (build-order step 7). Two
// jobs: decide whether a placement is legal, and turn two validated setups into
// the GameState the first order phase runs on.
//
// This is the single authority both the UI and the engine call (§12). The setup
// UI (step 10) highlights `legalPlacementHexes` and the engine re-checks the
// same rules in `startMatch`, so "the UI must offer only legal hexes" is one
// function used twice rather than two implementations that can disagree.
//
// Three things here are load-bearing:
//   - **Placement reads `RULES.placementTerrain`, never `TerrainDef.
//     groundPassable`** (§2, §12). Static structures are built, not driven: a
//     mountain stops a launcher but not a construction crew, so bunker, decoy and
//     interceptor base may all sit on one. The field was renamed `groundPassable`
//     precisely so that reaching for it here looks wrong.
//   - **Validation never consults the enemy's placements.** It cannot: the two
//     home zones are disjoint row bands (§7), so a collision between the two
//     players is geometrically impossible and there is nothing to check. That is
//     also what keeps it safe — a validator that read the opponent's setup would
//     make `legalPlacementHexes` a detector, handing a player the enemy's secret
//     placement as a hole in their own highlight overlay.
//   - **Every rule that names the bunker names the decoy identically** (§12).
//     There is exactly one asymmetry in this file, and it is HP, which lives in
//     `UNIT_DEFS` and is never read here.

import { ALL_SPAWN_HEXES, RULES, SPAWNS, UNIT_DEFS, type PlaceableKind } from './defs';
import {
  axialToOffset,
  distance,
  hexKey,
  offsetToAxial,
  type Hex,
} from './hex';
import { tileAt, type MapData } from './map';
import {
  PLAYERS,
  type GameState,
  type PlayerId,
  type Unit,
  type UnitId,
} from './types';

/** One asset a player places during SETUP (spec §12). */
export interface Placement {
  kind: PlaceableKind;
  hex: Hex;
}

/**
 * A player's secret setup, in placement order: bunker, decoy, then both bases.
 *
 * Also used for a *partial* setup while the UI is collecting placements — every
 * function here takes "what has been placed so far" rather than a finished
 * roster, which is what lets the same rules drive the highlight for step 2 of 4.
 */
export type PlayerSetup = readonly Placement[];

/**
 * Spec §12's roster, in canonical order.
 *
 * **This is the order assets are *listed and built in*, not an order the player
 * must place them in** (changed 2026-08-13). It has two jobs, both structural:
 * it is the order `startingUnits` adds a player's placed assets to
 * `GameState.units`, which §9 makes the log's order and therefore has to be a
 * function of the setup rather than of the clicks that produced it; and it is
 * the order the setup UI lists the four slots in.
 *
 * It used to be an *enforced* sequence, with `validatePlacement` rejecting
 * anything else as OUT_OF_ORDER, because the ≥3 exclusion rule was only checked
 * from the base's side and a base placed first would have had nothing to be
 * checked against. That check is now symmetric (see `validatePlacement`), so the
 * ordering constraint is gone and the set of legal boards is unchanged.
 *
 * Not a balance number, so it stays here rather than in `defs.ts`.
 * `setup.test.ts` asserts this covers exactly the kinds in
 * `RULES.placementCounts`, so a new placeable kind cannot be added to the roster
 * without being given a position in the order.
 */
export const PLACEMENT_ORDER = [
  'bunker',
  'decoy',
  'interceptor',
] as const satisfies readonly PlaceableKind[];

export type PlacementIllegalReason =
  | 'ALREADY_PLACED' // this kind's `RULES.placementCounts` is full
  | 'OFF_MAP' // not a real tile
  | 'OUTSIDE_HOME_ZONE' // outside `RULES.homeZoneRows` for this player
  | 'SPAWN_HEX' // §12: placement may never use one of the 8 public spawns
  | 'FORBIDDEN_TERRAIN' // not in `RULES.placementTerrain` for this kind
  | 'HEX_TAKEN' // one of this player's own placed assets is already there
  | 'EXCLUSION_ZONE'; // a base and a site closer than `bunkerExclusionRadius`

export type PlacementValidation =
  | { legal: true }
  | { legal: false; reason: PlacementIllegalReason };

/** A setup that stops short of the full roster (spec §7's counts). */
export type SetupIllegalReason = PlacementIllegalReason | 'INCOMPLETE';

/** `index` is the placement that failed — or the missing slot, if INCOMPLETE. */
export type SetupValidation =
  | { legal: true }
  | { legal: false; index: number; reason: SetupIllegalReason };

/** The 8 public spawn hexes (spec §7), keyed for lookup. */
const SPAWN_KEYS: ReadonlySet<string> = new Set(
  ALL_SPAWN_HEXES.map((offset) => hexKey(offsetToAxial(offset))),
);

/** Total assets a complete setup places — 1 bunker + 1 decoy + 2 bases. */
const ROSTER_SIZE = Object.values(RULES.placementCounts).reduce(
  (total, count) => total + count,
  0,
);

function countOf(placed: PlayerSetup, kind: PlaceableKind): number {
  return placed.filter((p) => p.kind === kind).length;
}

/**
 * The first kind still owed by `placed`, in canonical roster order, or null when
 * the roster is complete (spec §12).
 *
 * **A suggestion, not a requirement** — placement order is free (see
 * `validatePlacement`), so this is what the setup UI *pre-selects* after each
 * placement so a player who just wants to click four times never has to choose.
 * It is also what `sandboxSetup` walks.
 *
 * It lives here rather than in the UI because it is made of `PLACEMENT_ORDER`
 * plus `RULES.placementCounts` and nothing else, and those belong to the roster.
 * A client that derived the roster for itself would be a second definition of
 * what a complete setup is.
 */
export function nextPlacementKind(placed: PlayerSetup): PlaceableKind | null {
  for (const kind of PLACEMENT_ORDER) {
    if (countOf(placed, kind) < RULES.placementCounts[kind]) return kind;
  }
  return null;
}

/** Whether `kind` is a bunker site — the real one or the decoy. §12's
 *  indistinguishability principle in one predicate: every rule that asks this
 *  question must get the same answer for both, and the only way to guarantee
 *  that is for there to be one place the question is asked. */
function isSite(kind: PlaceableKind): boolean {
  return kind === 'bunker' || kind === 'decoy';
}

/**
 * Whether `playerId` may place `kind` on `hex`, given what they have already
 * placed (spec §12).
 *
 * Checks run roster-first, then geometry, so the reason is the most fundamental
 * thing wrong: a third bunker reports ALREADY_PLACED rather than commenting on
 * where it was going to stand. Within the geometry the order is
 * outward-to-inward — is it a tile at all, is it your ground, is it a hex
 * placement may never use, will the terrain take it, is it free, is it clear of
 * the exclusion zone — which is the order a player would ask them in.
 *
 * **There is no placement order** (changed 2026-08-13). `placed` is whatever the
 * player has put down so far, in any sequence, and every check here reads it as
 * a set rather than as a prefix of a fixed roster.
 */
export function validatePlacement(
  map: MapData,
  playerId: PlayerId,
  kind: PlaceableKind,
  hex: Hex,
  placed: PlayerSetup,
): PlacementValidation {
  if (countOf(placed, kind) >= RULES.placementCounts[kind]) {
    return { legal: false, reason: 'ALREADY_PLACED' };
  }

  const offset = axialToOffset(hex);
  const tile = tileAt(map, offset);
  if (!tile) return { legal: false, reason: 'OFF_MAP' };

  const zone = RULES.homeZoneRows[playerId];
  if (offset.row < zone.min || offset.row > zone.max) {
    return { legal: false, reason: 'OUTSIDE_HOME_ZONE' };
  }

  // All 8 spawns, not just this player's four. A player's own home zone holds
  // only their own spawns, so the distinction never arises in practice — but the
  // rule as written is "placement may never use a spawn hex" (§12), and testing
  // the full set is the rule rather than a consequence of the map layout.
  if (SPAWN_KEYS.has(hexKey(hex))) {
    return { legal: false, reason: 'SPAWN_HEX' };
  }

  // `RULES.placementTerrain`, NOT `TerrainDef.groundPassable` — see the header.
  // In V1 both terrains are legal for all three kinds, so this cannot currently
  // fail; it is here because the rule is data, and a balance pass that removes
  // mountains from one row of that table must take effect without a code change.
  if (!RULES.placementTerrain[kind].includes(tile.terrain)) {
    return { legal: false, reason: 'FORBIDDEN_TERRAIN' };
  }

  if (placed.some((p) => hexKey(p.hex) === hexKey(hex))) {
    return { legal: false, reason: 'HEX_TAKEN' };
  }

  // §12: a base must be at least `bunkerExclusionRadius` from BOTH the bunker
  // and the decoy, so neither site nor its neighbours sit inside friendly
  // coverage — no point-blank shield.
  //
  // **Checked symmetrically, from whichever side is being placed** (changed
  // 2026-08-13). The rule is a constraint on a *pair*, so asking it only of the
  // base was what forced a placement order: a base put down first had no site to
  // measure against and passed vacuously. Asking it of whichever asset arrives
  // second removes that need without changing the set of legal boards by a
  // single hex, and it is what lets the setup UI offer the four assets in any
  // order.
  //
  // The reason code deliberately does not say *which* asset was too close, and
  // in particular never distinguishes bunker from decoy — an asymmetry here
  // would be exactly the shape of tell §12 exists to prevent, and the player
  // seeing this message knows all their own positions anyway.
  const tooClose = placed.some(
    (p) => isSite(p.kind) !== isSite(kind) &&
      distance(p.hex, hex) < RULES.bunkerExclusionRadius,
  );
  if (tooClose) return { legal: false, reason: 'EXCLUSION_ZONE' };

  return { legal: true };
}

/**
 * Every hex `playerId` may legally place `kind` on right now — the setup UI's
 * highlight list (spec §12), and the `reachableHexes` of this module.
 *
 * Scans the home zone rather than the whole board, because a placement outside
 * it can never be legal; the returned hexes are in the map's own column-major
 * order, so the list is deterministic. Returns empty when this kind's roster
 * slots are all full, which is the same answer the UI wants: nothing to
 * highlight.
 *
 * Any kind may be asked about at any time — there is no placement order (see
 * `validatePlacement`), so this answers "where could my decoy go right now" even
 * with the bunker still in hand.
 */
export function legalPlacementHexes(
  map: MapData,
  playerId: PlayerId,
  kind: PlaceableKind,
  placed: PlayerSetup,
): Hex[] {
  const zone = RULES.homeZoneRows[playerId];
  const legal: Hex[] = [];

  for (let col = 0; col < map.width; col++) {
    for (let row = zone.min; row <= zone.max; row++) {
      const hex = offsetToAxial({ col, row });
      if (validatePlacement(map, playerId, kind, hex, placed).legal) {
        legal.push(hex);
      }
    }
  }

  return legal;
}

/**
 * Whether a complete setup is legal (spec §12).
 *
 * Replays the placements in submission order, validating each against the ones
 * before it — exactly what the UI did interactively — so a setup assembled any
 * other way (a saved game, a V1.5 client message, a test) is held to the same
 * rules. A short roster fails as INCOMPLETE against the first missing slot; an
 * over-long one fails as ALREADY_PLACED on the placement that overflowed.
 *
 * **Replay order stopped mattering when the exclusion check became symmetric**
 * (2026-08-13). A base and a site closer than `bunkerExclusionRadius` are now
 * caught whichever of the two the replay reaches second, so a setup submitted in
 * any sequence gets the same verdict — which is what makes free placement safe
 * to expose at all. `setup.test.ts` pins it by shuffling a bad setup.
 */
export function validateSetup(
  map: MapData,
  playerId: PlayerId,
  setup: PlayerSetup,
): SetupValidation {
  for (let index = 0; index < setup.length; index++) {
    const { kind, hex } = setup[index];
    const check = validatePlacement(
      map,
      playerId,
      kind,
      hex,
      setup.slice(0, index),
    );
    if (!check.legal) return { legal: false, index, reason: check.reason };
  }

  if (setup.length < ROSTER_SIZE) {
    return { legal: false, index: setup.length, reason: 'INCOMPLETE' };
  }

  return { legal: true };
}

function makeUnit(
  id: UnitId,
  owner: PlayerId,
  kind: Unit['kind'],
  position: Hex,
): Unit {
  return { id, owner, kind, position, hp: UNIT_DEFS[kind].hp, destroyed: false };
}

/**
 * Every unit one player starts with: 3 launchers and a drone on their public
 * spawn hexes, plus the 4 assets they placed in secret (spec §7, §12).
 *
 * **Placements are emitted in `PLACEMENT_ORDER`, not in the order the player
 * placed them** (added 2026-08-13, when placement order became free). Unit array
 * order is canonical because §9 makes it the log's order, and "canonical" has to
 * mean a function of the *setup* rather than of the clicks that produced it —
 * otherwise two players who built identical boards in different sequences would
 * generate differently-ordered logs from the same position. Sorting here is what
 * keeps that invariant true now that the UI no longer imposes a sequence.
 *
 * Ids are readable (`p1-launcher-2`) because the engine and its tests are the
 * only readers — nothing derives meaning from a `UnitId` (§6), and no event that
 * masks a decoy carries one, so a readable id can never become a tell. The two
 * events that do name a unit publicly are `UNIT_DESTROYED`, which reports a
 * decoy truthfully by design, and `DRONE_DOWNED`, which the owner already knows
 * about.
 */
function startingUnits(playerId: PlayerId, setup: PlayerSetup): Unit[] {
  const units = SPAWNS[playerId].launchers.map((offset, i) =>
    makeUnit(`${playerId}-launcher-${i + 1}`, playerId, 'launcher', offsetToAxial(offset)),
  );

  units.push(
    makeUnit(
      `${playerId}-drone`,
      playerId,
      'drone',
      offsetToAxial(SPAWNS[playerId].drone),
    ),
  );

  for (const kind of PLACEMENT_ORDER) {
    // Within a kind, the player's own sequence is kept — it is what numbers the
    // two bases, and it is the only ordering left that the player controls.
    const ofKind = setup.filter((p) => p.kind === kind);
    ofKind.forEach(({ hex }, i) => {
      // Single-instance kinds get a bare name; only the two bases are numbered.
      const suffix = RULES.placementCounts[kind] > 1 ? `-${i + 1}` : '';
      units.push(makeUnit(`${playerId}-${kind}${suffix}`, playerId, kind, hex));
    });
  }

  return units;
}

/**
 * The SETUP -> ORDER_PHASE edge of spec §5's state machine: two validated
 * secret setups become the board round 1 is played on.
 *
 * Throws on an illegal setup rather than returning a verdict. Both setups have
 * already passed `validateSetup` in the UI by the time this is called, so
 * reaching here with a bad one is a caller bug, and the alternative — starting a
 * match on an illegal board — is the kind of thing that surfaces ten rounds
 * later as an unexplainable rules violation. Same reasoning as `generateMap`
 * throwing rather than shipping an unplayable map (§7).
 *
 * Unit array order is canonical and therefore load-bearing: events naming a unit
 * are emitted in `GameState.units` order (§9), so this order is the log's order.
 * P1's units come first and each side runs launchers, drone, then placements in
 * placement order. Which side leads is arbitrary; that it never varies is not.
 */
export function startMatch(
  map: MapData,
  setups: Record<PlayerId, PlayerSetup>,
): GameState {
  const units: Unit[] = [];

  for (const playerId of PLAYERS) {
    const setup = setups[playerId];
    const check = validateSetup(map, playerId, setup);
    if (!check.legal) {
      throw new Error(
        `startMatch: illegal ${playerId} setup — placement ${check.index} is ${check.reason}`,
      );
    }
    units.push(...startingUnits(playerId, setup));
  }

  return {
    round: 1,
    phase: 'ORDER_PHASE',
    map,
    units,
    intel: {
      p1: { staticReveals: [], contacts: [] },
      p2: { staticReveals: [], contacts: [] },
    },
    droneRespawnIn: { p1: 0, p2: 0 },
    deadHandFor: null,
    outcome: null,
  };
}
