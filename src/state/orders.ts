// CLIENT STATE — the order builder's logic (build-order step 10a).
//
// Same discipline as `match.ts`: a plain, testable module with no React in it.
// React lives in the components; this file just answers three questions —
// *which of my units may be ordered*, *where may this one legally be sent*, and
// *what does my draft add up to* — and answers the middle one by asking the real
// sim validators through `./belief`, never by re-implementing a rule.
//
// **This module hand-rolls no legality.** Every "is that allowed?" bottoms out in
// `reachableHexes`, `validateMove`, `validateLaunch` or `validateFly` — the exact
// functions `resolve()` trusts. A second, client-side copy of the rules would
// drift, and the first thing it would drift into is offering the player a move
// the engine then silently refuses.
//
// The one thing it *does* decide is presentation-shaped and spelled out below:
// which targets to OFFER. Offering is not legality — a legal order can still be
// a bad idea, and (spec §9) a legal MOVE can still fail at resolution against a
// unit the player could not see. The highlight is a prediction, never a promise.

import { RULES, UNIT_DEFS } from '../sim/defs';
import { validateMarch } from '../sim/movement';
import {
  axialToOffset,
  compareHex,
  hexKey,
  hexesInRange,
  type Hex,
} from '../sim/hex';
import { tileAt, type MapData } from '../sim/map';
import { validateLaunch } from '../sim/missiles';
import { groundBudget, reachableHexes, validateMove } from '../sim/movement';
import { validateFly } from '../sim/recon';
import type { Order, Unit, UnitId, VisibleGameState } from '../sim/types';
import { believedState, knownEnemyHexes } from './belief';

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

/**
 * Which order kind the player is composing.
 *
 * Derived from `Order` rather than written out as `'MOVE' | 'LAUNCH' | 'FLY'`,
 * which is exactly what it evaluates to. If the sim ever gains an order kind,
 * this union gains it too instead of quietly falling one short.
 */
export type OrderMode = Order['type'];

/**
 * **Deliberate inaction.** A launcher with no order holds position and a drone
 * with no order hovers (spec §3), and hovering in particular is a real tactical
 * choice, not a wasted round (§11) — it trades the width of a sweep for the
 * certainty of not flying into a coverage bubble.
 *
 * So "hold" needs to be something the player can *say*, distinct from "I have
 * not decided yet". It never reaches the engine: `draftOrders` strips these out,
 * and a unit the engine receives no order for holds anyway. Its entire job is to
 * make "I am finished deciding" expressible, which is what lets the round
 * resolve on its own (`allDecided`).
 */
export interface HoldEntry {
  type: 'HOLD';
  unitId: UnitId;
}

/** One unit's decision for the round: an order, or an explicit hold. */
export type DraftEntry = Order | HoldEntry;

/**
 * Spec §9's one-order-per-unit budget (`RULES.ordersPerUnit` = 1), enforced by
 * the data shape rather than by a check: a record keyed by `UnitId` cannot hold
 * two entries for one unit, so setting a second decision *replaces* the first.
 *
 * An array of orders would let the UI queue a MOVE *and* a LAUNCH for one
 * launcher, and the engine's answer to that is to make the unit do **nothing at
 * all** — it never guesses which order was meant (§9). A record makes the
 * mistake unrepresentable instead of merely unlikely.
 */
export type OrderDraft = Readonly<Record<UnitId, DraftEntry>>;

/** An empty draft. Exported so the store and its tests share one value. */
export const EMPTY_DRAFT: OrderDraft = {};

// ---------------------------------------------------------------------------
// Which units may be ordered, and how
// ---------------------------------------------------------------------------

/**
 * The order kinds `unit` may be given right now, in the order a panel should
 * show them. An empty list means "this unit takes no orders", which is the
 * normal state of a bunker, a decoy, an interceptor base and any wreck.
 *
 * Three rules are folded in here, all of them the spec's:
 *
 *   - **Only launchers and the drone are orderable** (§3). Bunkers, decoys and
 *     bases are permanently static and act passively.
 *   - **MOVE is launcher-only, FLY is drone-only** (§9, §11). A MOVE naming the
 *     drone is a category error the sim rejects with `AIR_UNIT`; it is never
 *     offered here, so an honest UI cannot produce one.
 *   - **The dead-hand round is launches only, by the decapitated player alone**
 *     (§3). Their opponent issues no orders at all that round, so every unit on
 *     that side returns an empty list — which is also what stops the round from
 *     auto-resolving forever on a vacuously-complete draft (see `allDecided`).
 *
 * **MARCH is deliberately absent from this list for now** (2026-08-13). The
 * forced-march rule is complete and tested in `src/sim/`, but its UI — a third
 * order button, a second movement overlay that has to read as "further, and
 * loud", and the CPU tiers deciding when the reveal is worth paying — is its own
 * session. This function is the single gate: `isLegalOrder` consults it before
 * calling the validator, so until 'MARCH' is added here no draft, no click and
 * no CPU can produce one, and the sim rule sits inert. Adding it is the first
 * line of that session, not an oversight to fix in passing.
 */
export function modesFor(view: VisibleGameState, unit: Unit): OrderMode[] {
  if (view.outcome !== null || view.phase === 'GAME_OVER') return [];
  // A wreck takes no orders. The drone is flagged destroyed while it is down
  // and revived in place on respawn (§11), so this covers the blind round too.
  if (unit.destroyed) return [];

  if (view.phase === 'DEAD_HAND_PHASE') {
    if (view.deadHandFor !== unit.owner) return [];
    return unit.kind === 'launcher' ? ['LAUNCH'] : [];
  }

  if (unit.kind === 'launcher') return ['MOVE', 'LAUNCH'];
  if (unit.kind === 'drone') return ['FLY'];
  return [];
}

/**
 * Every unit the viewer may give an order to this round.
 *
 * Derived from `modesFor` rather than from a second list of kinds, so the two
 * can never disagree about whether a unit is orderable — which matters, because
 * `allDecided` counts this list and a mismatch would either stall the round or
 * fire it early.
 */
export function orderableUnits(view: VisibleGameState): Unit[] {
  return view.units.filter((unit) => modesFor(view, unit).length > 0);
}

// ---------------------------------------------------------------------------
// Legal targets
// ---------------------------------------------------------------------------

/** Sorted so a target list is deterministic and two runs draw the same overlay. */
function sorted(hexes: Hex[]): Hex[] {
  return hexes.sort(compareHex);
}

function onMap(map: MapData, hex: Hex): boolean {
  return tileAt(map, axialToOffset(hex)) !== undefined;
}

/**
 * Hexes within a straight-line `range` of `from` that are really on the board,
 * excluding `from` itself.
 *
 * Shared by launching and flying because the *geometry* is shared — both are
 * straight-line reaches over everything on the ground, and neither has anything
 * to do with the movement flood fill. The two callers pass their own constant
 * and carry their own rule; see each one.
 *
 * `hexesInRange` is pure geometry and cheerfully returns hexes off the edge of
 * the map, so `onMap` is not optional (CLAUDE.md gotcha 37).
 */
function straightLineTargets(map: MapData, from: Hex, range: number): Hex[] {
  const origin = hexKey(from);
  return sorted(
    hexesInRange(from, range).filter(
      (hex) => hexKey(hex) !== origin && onMap(map, hex),
    ),
  );
}

/**
 * Where this launcher may be sent (spec §9).
 *
 * Built from `reachableHexes` — the real cost-aware flood fill, which already
 * knows that mountains are impassable, that living ground units block both
 * passage and landing, and that a hex three steps away in a straight line can be
 * genuinely unreachable. It is emphatically not a `distance <= 3` check.
 *
 * **Minus `knownEnemyHexes`**, and that subtraction is the whole reason this
 * function is not one line. `believedState` contains no enemy units at all
 * (that absence is what keeps the legality highlight from doubling as a
 * detector), so the flood fill has nothing to reject a detected enemy's hex
 * with — it would happily offer the player a hex they can plainly see is
 * occupied. Spec §9 rules that a move blocked by a unit the player can
 * *currently see* is "rejected at order entry"; this is that rejection.
 *
 * What stays offered, on purpose: hexes holding an enemy the player has NOT
 * detected. Ordering a launcher there fails entirely and it holds (§9,
 * `MOVE_FAILED`). That risk is the reason flying the drone is worth a round.
 */
export function moveTargets(view: VisibleGameState, unit: Unit): Hex[] {
  return groundTargets(view, unit, 'MOVE');
}

/**
 * Where this launcher may be sent on a forced march (spec §9, §11).
 *
 * The same function as `moveTargets` on a bigger budget — a march is a walk
 * that goes further and is heard doing it, not a different kind of movement, so
 * the terrain, the flood fill and the detected-enemy subtraction are all shared.
 * The *cost* of picking one of these hexes is not visible in this list at all:
 * it is the public `MARCH_DETECTED` on your origin, which the panel has to say
 * in words because no highlight can show it.
 */
export function marchTargets(view: VisibleGameState, unit: Unit): Hex[] {
  return groundTargets(view, unit, 'MARCH');
}

/**
 * The shared body of `moveTargets` / `marchTargets` — the only difference
 * between them is the budget, which comes from the sim's own `groundBudget` so
 * the highlight cannot offer a hex the engine would then refuse.
 */
function groundTargets(
  view: VisibleGameState,
  unit: Unit,
  mode: 'MOVE' | 'MARCH',
): Hex[] {
  if (!modesFor(view, unit).includes(mode)) return [];

  const known = knownEnemyHexes(view);
  const origin = hexKey(unit.position);
  const targets: Hex[] = [];

  const budget = groundBudget(unit, mode);
  for (const { hex } of reachableHexes(believedState(view), unit, budget).values()) {
    const key = hexKey(hex);
    if (key === origin) continue; // SAME_HEX — ordering a unit where it stands
    if (known.has(key)) continue; // seen to be occupied (§9)
    targets.push(hex);
  }
  return sorted(targets);
}

/**
 * Where this launcher may fire (spec §3, §10).
 *
 * **No terrain filter, and adding one would be a rules bug, not a tidy-up**
 * (CLAUDE.md gotcha 7c). Missiles ignore terrain in flight *and* in targeting.
 * Bunkers, decoys and interceptor bases may all be built on mountains (§2, §12),
 * so a targeting rule that skipped impassable hexes would make a mountain bunker
 * literally invulnerable and hand its owner a guaranteed win.
 *
 * Blind fire at hexes holding nothing the player can see is legal and stays
 * offered — it is the norm, not the exception (§3). Firing *at* a detected enemy
 * is likewise the point, which is why `knownEnemyHexes` is subtracted from moves
 * and never from this.
 */
export function launchTargets(view: VisibleGameState, unit: Unit): Hex[] {
  if (!modesFor(view, unit).includes('LAUNCH')) return [];
  return straightLineTargets(view.map, unit.position, RULES.missileRange);
}

/**
 * Where the drone may fly (spec §11).
 *
 * `UNIT_DEFS.drone.movement` is a straight-line **flight** range, never a ground
 * budget (CLAUDE.md gotcha 10) — the drone crosses terrain and units alike, so
 * feeding it to `reachableHexes` would produce a confidently wrong answer that
 * looks plausible. The flood fill is not involved here at any point.
 *
 * The drone's own hex is excluded because ordering it there is illegal on
 * purpose: *give no order to hover*. Hovering is still a real choice — a drone
 * with no order transmits the corridor around its own hex — which is what the
 * HOLD entry above exists to express.
 */
export function flyTargets(view: VisibleGameState, unit: Unit): Hex[] {
  if (!modesFor(view, unit).includes('FLY')) return [];
  return straightLineTargets(view.map, unit.position, UNIT_DEFS.drone.movement);
}

/** `moveTargets` / `launchTargets` / `flyTargets`, chosen by mode. */
export function targetsFor(
  view: VisibleGameState,
  unit: Unit,
  mode: OrderMode,
): Hex[] {
  switch (mode) {
    case 'MOVE':
      return moveTargets(view, unit);
    case 'MARCH':
      return marchTargets(view, unit);
    case 'LAUNCH':
      return launchTargets(view, unit);
    case 'FLY':
      return flyTargets(view, unit);
  }
}

/** The `Order` value a (unit, mode, hex) choice means. */
export function orderFor(unit: Unit, mode: OrderMode, hex: Hex): Order {
  switch (mode) {
    case 'MOVE':
      return { type: 'MOVE', unitId: unit.id, destination: hex };
    case 'MARCH':
      return { type: 'MARCH', unitId: unit.id, destination: hex };
    case 'LAUNCH':
      return { type: 'LAUNCH', unitId: unit.id, target: hex };
    case 'FLY':
      return { type: 'FLY', unitId: unit.id, destination: hex };
  }
}

/**
 * Whether the engine's own validators accept this order against what the player
 * believes the board to be.
 *
 * The `modesFor` guard in front of the validator is not redundant: the sim's
 * validators know nothing about phases, so `validateMove` would cheerfully
 * accept a launcher MOVE during the dead-hand round, which §3 says is launches
 * only. Order kind is checked here; everything else is the sim's to judge.
 *
 * A unit id that is not the viewer's own fails at the `find` — a
 * `VisibleGameState` holds only its owner's units (spec §6), so "you can only
 * order your own pieces" needs no check at all.
 */
export function isLegalOrder(view: VisibleGameState, order: Order): boolean {
  const unit = view.units.find((u) => u.id === order.unitId);
  if (!unit) return false;
  if (!modesFor(view, unit).includes(order.type)) return false;

  const believed = believedState(view);
  switch (order.type) {
    case 'MOVE':
      return validateMove(believed, unit.owner, order).legal;
    case 'MARCH':
      return validateMarch(believed, unit.owner, order).legal;
    case 'LAUNCH':
      return validateLaunch(believed, unit.owner, order).legal;
    case 'FLY':
      return validateFly(believed, unit.owner, order).legal;
  }
}

// ---------------------------------------------------------------------------
// Editing the draft
// ---------------------------------------------------------------------------

/**
 * `draft` with `order` recorded against its unit, replacing whatever that unit
 * was going to do.
 *
 * **An illegal order is never stored** — the draft is returned unchanged (the
 * same reference, so a caller can tell nothing happened). That is what makes
 * "every order in a draft validates against belief" true by construction rather
 * than by a check somewhere downstream.
 */
export function withOrder(
  view: VisibleGameState,
  draft: OrderDraft,
  order: Order,
): OrderDraft {
  if (!isLegalOrder(view, order)) return draft;
  return { ...draft, [order.unitId]: order };
}

/**
 * `draft` with `unit` marked as deliberately holding — replacing any order it
 * had. Refused for a unit that cannot be ordered at all, so a hold is always a
 * decision someone was entitled to make.
 */
export function withHold(
  view: VisibleGameState,
  draft: OrderDraft,
  unit: Unit,
): OrderDraft {
  if (modesFor(view, unit).length === 0) return draft;
  const hold: HoldEntry = { type: 'HOLD', unitId: unit.id };
  return { ...draft, [unit.id]: hold };
}

/** `draft` with this unit's decision removed — back to undecided. */
export function withoutOrder(draft: OrderDraft, unitId: UnitId): OrderDraft {
  if (!(unitId in draft)) return draft;
  const next = { ...draft };
  delete next[unitId];
  return next;
}

/**
 * The orders this draft actually submits, sorted by unit id.
 *
 * HOLD entries are dropped here and never travel further: the engine's contract
 * is that a unit it receives no order for holds (§3), so a hold IS the empty
 * submission. The sort is for the client's own determinism only — `resolve()`
 * emits movement events in `GameState.units` order regardless of how a client
 * sorted its submission (§9, gotcha 14).
 */
export function draftOrders(draft: OrderDraft): Order[] {
  return Object.values(draft)
    .filter((entry): entry is Order => entry.type !== 'HOLD')
    .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0));
}

/** How many of this round's orderable units have been decided. */
export function decidedCount(view: VisibleGameState, draft: OrderDraft): number {
  return orderableUnits(view).filter((unit) => unit.id in draft).length;
}

/**
 * Whether every unit that could be ordered this round has been decided — the
 * trigger for resolving without pressing the button.
 *
 * **The `length > 0` guard is load-bearing.** During the opponent's dead-hand
 * round the viewer has no orderable units at all, and "every one of zero units
 * is decided" is vacuously true — without this, the round would resolve itself
 * the instant it began, and keep doing so. The same guard covers a finished
 * match and a side with nothing left alive.
 */
export function allDecided(view: VisibleGameState, draft: OrderDraft): boolean {
  const orderable = orderableUnits(view);
  return orderable.length > 0 && orderable.every((unit) => unit.id in draft);
}
