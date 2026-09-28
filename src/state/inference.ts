// CLIENT STATE — what a player can work out from their own history (presentation
// Session 3, intel overlays).
//
// Nothing here is a detector. Every answer is a deduction from two things the
// player already holds: their redacted board (`VisibleGameState`) and their
// filtered event log. A human with a pencil could draw the same picture, and the
// point of this file is that the human and the CPU draw it *identically* — the
// CPU's drone routing (`droneDangerHexes` in `./cpu`) and the board overlay both
// call `enemyBaseCandidates`, so the red shading a human sees is exactly the
// inference HARD flies around. Neither side is shown more than the other.
//
// Pure: no React, no Pixi, no store. `history` must be the viewer's FILTERED log
// (gotchas 34, 63); handing it the raw log would read the enemy's own flights.

import { RULES } from '../sim/defs';
import { axialToOffset, distance, hexKey, hexesInRange, type Hex } from '../sim/hex';
import { tileAt, type MapData } from '../sim/map';
import { reconSwath } from '../sim/recon';
import {
  opponentOf,
  type PlayerId,
  type VisibleEvent,
  type VisibleGameState,
} from '../sim/types';

function onMap(map: MapData, hex: Hex): boolean {
  return tileAt(map, axialToOffset(hex)) !== undefined;
}

/**
 * Where the enemy's hidden interceptor base could be, or `[]` when there is
 * nothing to infer — no clue yet, or the base is already on the map or dead.
 *
 * The clue is `DRONE_DOWNED` naming `player`: only a base kills a drone, so the
 * killer is within `R` (the coverage radius) of the death hex. Candidates are
 * then pruned three ways, all from public or own-side facts: the hex must be on
 * the board, inside the enemy's home zone (§12 — bases are placed there), and
 * NOT within `R` of any hex our drone ever transmitted from (`DRONE_MOVED.path`),
 * because a base there would have shot it down.
 *
 * Several unexplained deaths point at the same base while each player has one
 * (`RULES.placementCounts.interceptor`), so their candidate sets are
 * intersected. If they do not meet — which would mean more than one base — it
 * falls back to their union rather than trust a wrong inference.
 *
 * A clue is dropped once it is explained: by a base we can see (a static reveal
 * of kind `interceptor`), or by an enemy base publicly destroyed within `R` of
 * it. With one base per side, either one *was* the killer.
 *
 * **`MISSILE_INTERCEPTED` is deliberately not a clue here**, although it says the
 * same thing ("some base covers this hex"). Since the 2026-09-27 redesign a
 * base's first missile intercept also emits `BASE_EXPOSED`, so by the time an
 * intercept of ours is in the log its base is always on the map (or since
 * destroyed) — it could never narrow anything. The replay still shows its
 * 19-hex disc for the moment before the exposure lands (`playbackDraw.ts`).
 *
 * Only `DRONE_DOWNED` events naming `player` count: the event is public, and the
 * enemy's drone dying over our own base says nothing about theirs.
 *
 * May return off-board hexes in one fallback (a pruned set that came out empty);
 * anything that draws from it must filter with `tileAt` (gotcha 37).
 */
export function enemyBaseCandidates(
  view: VisibleGameState,
  history: readonly VisibleEvent[],
  player: PlayerId,
): Hex[] {
  const R = RULES.interceptorCoverageRadius;
  const zone = RULES.homeZoneRows[opponentOf(player)];

  const deaths: Hex[] = [];
  const deadBases: Hex[] = [];
  const transmitted = new Set<string>();
  for (const event of history) {
    if (event.type === 'DRONE_DOWNED' && event.owner === player) deaths.push(event.hex);
    if (event.type === 'DRONE_MOVED' && event.owner === player) {
      for (const hex of event.path) transmitted.add(hexKey(hex));
    }
    // `UNIT_DESTROYED` has no owner, so "was it theirs?" is a roster lookup
    // against our own units — dead ones included (gotcha 61).
    if (
      event.type === 'UNIT_DESTROYED' &&
      event.kind === 'interceptor' &&
      !view.units.some((u) => u.id === event.unitId)
    ) {
      deadBases.push(event.hex);
    }
  }

  const explained = [...knownEnemyBases(view), ...deadBases];
  const clues = deaths.filter((death) => !explained.some((b) => distance(b, death) <= R));
  if (clues.length === 0) return [];

  const couldHoldBase = (hex: Hex): boolean => {
    if (!onMap(view.map, hex)) return false;
    const { row } = axialToOffset(hex);
    if (row < zone.min || row > zone.max) return false;
    return !hexesInRange(hex, R).some((near) => transmitted.has(hexKey(near)));
  };
  const candidateSets = clues.map((clue) => {
    const disc = hexesInRange(clue, R);
    const pruned = disc.filter(couldHoldBase);
    // Cannot be empty if every rule above is right; a disc is the safe answer
    // if one of them is ever wrong.
    return new Map((pruned.length > 0 ? pruned : disc).map((h) => [hexKey(h), h]));
  });

  const candidates = [...candidateSets[0].values()];
  if (RULES.placementCounts.interceptor === 1) {
    const shared = candidates.filter((h) =>
      candidateSets.every((set) => set.has(hexKey(h))),
    );
    if (shared.length > 0) return shared;
  }
  return candidateSets.flatMap((set) => [...set.values()]);
}

/** Enemy bases on the viewer's map — exposed by a missile intercept (§10). */
export function knownEnemyBases(view: VisibleGameState): Hex[] {
  return view.intel.staticReveals
    .filter((reveal) => reveal.kind === 'interceptor')
    .map((reveal) => reveal.hex);
}

/**
 * Every on-board hex `player`'s drone has ever photographed, in first-seen
 * order (spec §11).
 *
 * Read off the player's own `DRONE_MOVED` events, whose `path` is what the drone
 * *transmitted* — on a downed flight it already stops one hex short of the kill
 * — so the reveal rule is honoured without this function knowing it. The
 * corridor comes from `reconSwath`, the sim's own authority, so a retune of
 * `reconSwathRadius` moves the overlay with the rule.
 *
 * Useful because sites cannot move: photographed ground holds no bunker or
 * decoy that is not already on your map. It says nothing about launchers, which
 * may have driven in since.
 */
export function photographedHexes(
  map: MapData,
  history: readonly VisibleEvent[],
  player: PlayerId,
): Hex[] {
  const seen = new Set<string>();
  const hexes: Hex[] = [];
  for (const event of history) {
    if (event.type !== 'DRONE_MOVED' || event.owner !== player) continue;
    const swath = reconSwath(event.path);
    for (const step of event.path) {
      for (const hex of hexesInRange(step, RULES.reconSwathRadius)) {
        const key = hexKey(hex);
        if (seen.has(key) || !swath.has(key) || !onMap(map, hex)) continue;
        seen.add(key);
        hexes.push(hex);
      }
    }
  }
  return hexes;
}

/**
 * Whether a one-hex `DRONE_MOVED` was a flight shot down on its first step
 * rather than a hover.
 *
 * The two events are identical: `path` is what the drone *transmitted* (gotcha
 * 16), so a drone downed entering its first new hex transmits only its start
 * hex, exactly like a hover. The same round's `DRONE_DOWNED` for that drone
 * tells them apart, and it can only mean the first case: a hovering drone never
 * enters a new hex, so it can never be shot down.
 */
export function downedOnFirstStep(
  event: Extract<VisibleEvent, { type: 'DRONE_MOVED' }>,
  roundEvents: readonly VisibleEvent[],
): boolean {
  return (
    event.path.length <= 1 &&
    roundEvents.some((e) => e.type === 'DRONE_DOWNED' && e.unitId === event.unitId)
  );
}

/** What the board's intel overlay draws (presentation Session 3). */
export interface IntelOverlay {
  /** Where the enemy's hidden base could be; empty once it is found or dead. */
  candidates: Hex[];
  /** Every hex the viewer's drone has photographed this match. */
  photographed: Hex[];
}

/**
 * The overlay `player` sees: drawn over their current board from their whole
 * log — or, while a replay of round N is pending, over the board from BEFORE
 * round N and without round N's entries, exactly as the event log holds that
 * round back. Otherwise the shading would settle on "your drone was shot down
 * here" before the replay had shown the drone going down.
 *
 * Structural parameter types rather than `LogEntry`/`Replay`, so this file
 * does not import the store.
 */
export function intelOverlay(
  view: VisibleGameState,
  log: readonly { round: number; event: VisibleEvent }[],
  replay: { round: number; from: VisibleGameState } | null,
  player: PlayerId,
): IntelOverlay {
  const board = replay ? replay.from : view;
  const history = log
    .filter((entry) => !replay || entry.round !== replay.round)
    .map((entry) => entry.event);
  return {
    candidates: enemyBaseCandidates(board, history, player).filter((hex) => onMap(board.map, hex)),
    photographed: photographedHexes(board.map, history, player),
  };
}
