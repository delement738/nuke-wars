// CLIENT STATE — not simulation code, and deliberately not in `src/sim/`.
//
// The CPU opponent. Given one player's own `VisibleGameState` and nothing
// else, produces the `Order[]` that player submits for the round. This is a
// *player*, not a rule — the same reasoning that keeps `sandbox.ts` out of
// `src/sim/` — so it has no business deciding what is legal; it only decides
// what to attempt, then asks the real engine validators whether the attempt
// holds up.
//
// **The CPU is handed exactly the fog a human in its seat would have.** It
// never sees `truth` — only the `VisibleGameState` `filterForPlayer` already
// produced for it — so it can be omniscient by neither accident nor a later
// "just for tuning" edit. `believedState` below turns that redacted view back
// into a `GameState`-shaped object containing ONLY what the player currently
// knows to exist (their own units; nothing standing in for an enemy), and every
// order this file proposes is checked against it with the SAME validators
// `resolve()` trusts — `validateMove`, `validateLaunch`, `validateFly`. That is
// deliberately one of the two shapes the spec's own open question about step 10
// names ("a client-side board as I believe it to be", CLAUDE.md's "What step 9
// leaves for step 10" note) — applied here to the CPU first, because it needed
// no UI to ship. An order that validates against belief can still fail for real
// at resolution if truth disagrees (an unseen blocker) — that is the intended
// risk, not a bug to route around, and it is exactly what a human strategist
// risks ordering a launcher into ground they have not scouted (spec §9).
//
// Three difficulties, and none of them search or look ahead — every one is a
// straight-line heuristic over the current round's `VisibleGameState`, fully
// stateless: nothing here remembers what it decided last round, so replaying
// the same (view, difficulty, seed) round always proposes the same orders.
//   - EASY mostly holds/hovers, and never reacts to intel — a small, seeded
//     chance of a random legal move, blind shot, or flight, otherwise nothing.
//   - MEDIUM advances toward the enemy's home zone and fires at whichever
//     known target — contact or site — is nearest, in range, kind-blind.
//   - HARD does what MEDIUM does, plus two concrete refinements: it prefers a
//     confirmed launcher contact over a bunker/decoy site when both are in
//     range (a contact is a certain kill this round, spec §11 — a launcher
//     that fired cannot also have moved), and it prefers a reachable hex
//     outside a known enemy launcher's range over one further toward the
//     front but exposed.

import { RULES, UNIT_DEFS } from '../sim/defs';
import {
  axialToOffset,
  distance,
  hexKey,
  hexesInRange,
  type Hex,
} from '../sim/hex';
import { tileAt } from '../sim/map';
import { validateLaunch } from '../sim/missiles';
import { reachableHexes, validateMove } from '../sim/movement';
import { validateFly } from '../sim/recon';
import {
  opponentOf,
  type GameState,
  type Order,
  type PlayerId,
  type PlayerIntel,
  type Unit,
  type VisibleGameState,
} from '../sim/types';

export type CpuDifficulty = 'easy' | 'medium' | 'hard';

/** Matches `makeRng`'s return shape (`src/sim/map.ts`) without importing it —
 * the CPU is client state, not simulation, and owns its own RNG instance. */
export type Rng = () => number;

// ---------------------------------------------------------------------------
// Belief — turning a VisibleGameState back into a GameState the real
// validators accept, containing only what this player actually knows.
// ---------------------------------------------------------------------------

/** Never read by `reachableHexes`/`validateMove`/`validateLaunch`/`validateFly`
 * — they touch only `units` and `map` — but `GameState` requires the field. */
const EMPTY_INTEL: PlayerIntel = { staticReveals: [], contacts: [] };

function believedState(view: VisibleGameState): GameState {
  return {
    round: view.round,
    phase: view.phase,
    map: view.map,
    units: view.units,
    intel: { p1: EMPTY_INTEL, p2: EMPTY_INTEL },
    droneRespawnIn: { p1: 0, p2: 0 },
    deadHandFor: view.deadHandFor,
    outcome: view.outcome,
  };
}

/** Hexes this player already believes hold an enemy asset (spec §11 intel) —
 * never a legal MOVE destination, even though `believedState` has no unit
 * there to reject it with `TILE_OCCUPIED`. Firing AT one of these is exactly
 * the point; this set is consulted for movement only. */
function knownEnemyHexes(view: VisibleGameState): Set<string> {
  const known = new Set<string>();
  for (const reveal of view.intel.staticReveals) known.add(hexKey(reveal.hex));
  for (const contact of view.intel.contacts) known.add(hexKey(contact.hex));
  return known;
}

/** The row this player advances toward: the near edge of the opponent's home
 * zone (spec §7) — as far as a launcher ever needs to go to threaten it. P1
 * marches north out of rows 13–18 toward P2's zone (0–5), so its target is
 * that zone's high-numbered edge; P2 mirrors it toward P1's low-numbered
 * edge. */
function advanceRow(player: PlayerId): number {
  const opponentZone = RULES.homeZoneRows[opponentOf(player)];
  return player === 'p1' ? opponentZone.max : opponentZone.min;
}

// ---------------------------------------------------------------------------
// Known targets (medium & hard)
// ---------------------------------------------------------------------------

export interface Target {
  hex: Hex;
  /** Lower fires first when a tier prioritises (spec §11 reasoning below). */
  priority: number;
}

/**
 * Everything this player currently has intel on, ranked for a HARD-tier
 * attacker. A launcher contact is a certain kill if reached this round — the
 * enemy launcher that fired could not also have moved (spec §11) — while a
 * bunker/decoy site is a valuable but uncertain test (§12: it might be the
 * fake). MEDIUM ignores the ranking (see `selectTarget`) and fires at
 * whichever is nearest, contact or site alike.
 */
function knownTargets(view: VisibleGameState): Target[] {
  const targets: Target[] = [];
  for (const contact of view.intel.contacts) {
    targets.push({ hex: contact.hex, priority: 0 });
  }
  for (const reveal of view.intel.staticReveals) {
    targets.push({ hex: reveal.hex, priority: 1 });
  }
  return targets;
}

/**
 * The one target a launcher fires at this round, or none if `candidates` is
 * empty.
 *
 * `ranked` (HARD only) sorts by `priority` first, distance second — certain
 * kills before uncertain tests, nearest within a tier. MEDIUM (`ranked` false)
 * sorts by distance alone, kind-blind: whichever is closest wins even if a
 * contact was also in range. This is the actual MEDIUM/HARD split — it is NOT
 * "contacts happen to be pushed first" in `knownTargets` above, which a stable
 * sort by priority would silently preserve regardless of `ranked` if distance
 * were not the tiebreak here too.
 */
export function selectTarget(
  candidates: readonly Target[],
  from: Hex,
  ranked: boolean,
): Target | undefined {
  return [...candidates].sort((a, b) => {
    if (ranked && a.priority !== b.priority) return a.priority - b.priority;
    return distance(from, a.hex) - distance(from, b.hex);
  })[0];
}

/** Hexes within missile range of a known enemy launcher contact — HARD's
 * movement avoids ending a move here when an equally good alternative exists.
 * Both contact sources are treated as live risk; a RECON contact may already
 * be one round stale (§11), but that is a reason to be less SURE the danger
 * is real, not a reason a heuristic this simple should ignore it. */
function dangerHexes(view: VisibleGameState): Set<string> {
  const danger = new Set<string>();
  for (const contact of view.intel.contacts) {
    for (const hex of hexesInRange(contact.hex, RULES.missileRange)) {
      danger.add(hexKey(hex));
    }
  }
  return danger;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function pickRandom<T>(items: readonly T[], rng: Rng): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(rng() * items.length)];
}

function onMap(map: GameState['map'], hex: Hex): boolean {
  return tileAt(map, axialToOffset(hex)) !== undefined;
}

function nearestTo(hexes: readonly Hex[], from: Hex): Hex {
  return hexes.reduce((best, hex) =>
    distance(from, hex) < distance(from, best) ? hex : best,
  );
}

// ---------------------------------------------------------------------------
// MEDIUM & HARD — reactive movement and fire
// ---------------------------------------------------------------------------

/** A small detour is worth trading for safety; a large one is not — see the
 * comment inside `pickAdvanceDestination`. Exported so a test can assert
 * against the real number instead of a copy-pasted `1`. */
export const SAFETY_DETOUR_TOLERANCE = 1;

/**
 * The reachable hex making the most progress toward `targetRow`, never one in
 * `avoid` (a known enemy site).
 *
 * When `danger` is given (HARD only) and the single most-advanced hex sits
 * inside it, a safe hex is taken instead ONLY if it costs at most
 * `SAFETY_DETOUR_TOLERANCE` hexes of extra progress — a short detour for
 * safety is worth it (spec §3: "the safe way to fire is from inside your own
 * interceptor coverage or outside enemy reach"), but refusing to advance at
 * all over a one-hex risk would make HARD more passive than MEDIUM, not
 * smarter. If the most-advanced hex is itself safe, or no safe alternative is
 * close enough, it is simply taken.
 */
export function pickAdvanceDestination(
  believed: GameState,
  launcher: Unit,
  targetRow: number,
  avoid: ReadonlySet<string>,
  danger: ReadonlySet<string> | null,
): Hex | null {
  let best: { hex: Hex; score: number; safe: boolean } | null = null;
  let bestSafe: { hex: Hex; score: number } | null = null;

  for (const { hex } of reachableHexes(believed, launcher).values()) {
    const key = hexKey(hex);
    if (key === hexKey(launcher.position)) continue; // SAME_HEX is illegal
    if (avoid.has(key)) continue;

    const score = Math.abs(axialToOffset(hex).row - targetRow);
    const safe = !danger || !danger.has(key);

    if (!best || score < best.score) best = { hex, score, safe };
    if (safe && (!bestSafe || score < bestSafe.score)) bestSafe = { hex, score };
  }

  if (!best) return null;
  if (best.safe || !bestSafe) return best.hex;
  return bestSafe.score <= best.score + SAFETY_DETOUR_TOLERANCE ? bestSafe.hex : best.hex;
}

/** One launcher's order for MEDIUM/HARD: fire on anything in range (ranked
 * only for HARD), otherwise advance toward the front. */
function reactiveLauncherOrder(
  believed: GameState,
  player: PlayerId,
  launcher: Unit,
  targets: readonly Target[],
  targetRow: number,
  avoid: ReadonlySet<string>,
  danger: ReadonlySet<string> | null,
  ranked: boolean,
): Order | null {
  const inRange = targets.filter(
    (t) => distance(launcher.position, t.hex) <= RULES.missileRange,
  );
  const target = selectTarget(inRange, launcher.position, ranked);
  if (target) {
    const order: Order = { type: 'LAUNCH', unitId: launcher.id, target: target.hex };
    if (validateLaunch(believed, player, order).legal) return order;
  }

  const destination = pickAdvanceDestination(believed, launcher, targetRow, avoid, danger);
  if (!destination) return null;
  const order: Order = { type: 'MOVE', unitId: launcher.id, destination };
  return validateMove(believed, player, order).legal ? order : null;
}

/** The drone's order for MEDIUM/HARD: fly as far toward the front as its
 * flight range allows, among every legal destination (spec §11 — straight
 * line, ignores terrain and units, so this is pure geometry, not a flood
 * fill). No sweep memory: every round re-picks fresh from the current hex. */
function reactiveDroneOrder(
  believed: GameState,
  player: PlayerId,
  drone: Unit,
  targetRow: number,
): Order | null {
  const candidates = hexesInRange(drone.position, UNIT_DEFS.drone.movement).filter(
    (hex) => hexKey(hex) !== hexKey(drone.position) && onMap(believed.map, hex),
  );

  let best: { hex: Hex; score: number } | null = null;
  for (const hex of candidates) {
    const score = Math.abs(axialToOffset(hex).row - targetRow);
    if (!best || score < best.score) best = { hex, score };
  }
  if (!best) return null;

  const order: Order = { type: 'FLY', unitId: drone.id, destination: best.hex };
  return validateFly(believed, player, order).legal ? order : null;
}

// ---------------------------------------------------------------------------
// EASY — mostly idle, never reacts to intel
// ---------------------------------------------------------------------------

const EASY_HOLD_CHANCE = 0.7;
const EASY_HOVER_CHANCE = 0.65;
/** When EASY does act, the split between moving and firing blind. */
const EASY_MOVE_VS_FIRE = 0.5;

function easyLauncherOrder(
  believed: GameState,
  player: PlayerId,
  launcher: Unit,
  rng: Rng,
): Order | null {
  if (rng() < EASY_HOLD_CHANCE) return null;

  if (rng() < EASY_MOVE_VS_FIRE) {
    const reachable = [...reachableHexes(believed, launcher).values()]
      .map((r) => r.hex)
      .filter((hex) => hexKey(hex) !== hexKey(launcher.position));
    const destination = pickRandom(reachable, rng);
    if (!destination) return null;
    const order: Order = { type: 'MOVE', unitId: launcher.id, destination };
    return validateMove(believed, player, order).legal ? order : null;
  }

  const inRange = hexesInRange(launcher.position, RULES.missileRange).filter(
    (hex) => hexKey(hex) !== hexKey(launcher.position) && onMap(believed.map, hex),
  );
  const target = pickRandom(inRange, rng);
  if (!target) return null;
  const order: Order = { type: 'LAUNCH', unitId: launcher.id, target };
  return validateLaunch(believed, player, order).legal ? order : null;
}

function easyDroneOrder(
  believed: GameState,
  player: PlayerId,
  drone: Unit,
  rng: Rng,
): Order | null {
  if (rng() < EASY_HOVER_CHANCE) return null;

  const inRange = hexesInRange(drone.position, UNIT_DEFS.drone.movement).filter(
    (hex) => hexKey(hex) !== hexKey(drone.position) && onMap(believed.map, hex),
  );
  const destination = pickRandom(inRange, rng);
  if (!destination) return null;
  const order: Order = { type: 'FLY', unitId: drone.id, destination };
  return validateFly(believed, player, order).legal ? order : null;
}

// ---------------------------------------------------------------------------
// Dead hand — spec §3's final volley, all difficulties
// ---------------------------------------------------------------------------

/**
 * Every surviving launcher fires once, LAUNCH only (spec §3 — no movement, no
 * recon in this round). Deliberately NOT `knownTargets`'s ranking: a launcher
 * contact is worthless here. `adjudicate()` checks bunker outcomes before it
 * ever reads a launcher count (`src/sim/outcomes.ts`), so killing the enemy's
 * launchers with this volley cannot change the verdict — the only shot that
 * matters is one that also kills their REAL bunker, turning a loss into Mutual
 * Annihilation. So this targets known bunker/decoy sites only, and blind-fires
 * into the opponent's home zone when nothing is known — never at a contact.
 * There is nothing left to lose by firing, so every launcher always fires.
 */
function deadHandOrders(
  view: VisibleGameState,
  difficulty: CpuDifficulty,
  player: PlayerId,
  rng: Rng,
): Order[] {
  const believed = believedState(view);
  const launchers = view.units.filter((u) => u.kind === 'launcher' && !u.destroyed);
  const staticTargets = view.intel.staticReveals.map((r) => r.hex);
  const opponent = opponentOf(player);
  const zone = RULES.homeZoneRows[opponent];

  const orders: Order[] = [];
  for (const launcher of launchers) {
    const inRange = staticTargets.filter(
      (hex) => distance(launcher.position, hex) <= RULES.missileRange,
    );

    let target: Hex | undefined;
    if (inRange.length > 0) {
      target =
        difficulty === 'easy' ? pickRandom(inRange, rng) : nearestTo(inRange, launcher.position);
    } else {
      const candidates = hexesInRange(launcher.position, RULES.missileRange).filter(
        (hex) => hexKey(hex) !== hexKey(launcher.position) && onMap(believed.map, hex),
      );
      const zoned = candidates.filter((hex) => {
        const row = axialToOffset(hex).row;
        return row >= zone.min && row <= zone.max;
      });
      target = pickRandom(zoned.length > 0 ? zoned : candidates, rng);
    }
    if (!target) continue;

    const order: Order = { type: 'LAUNCH', unitId: launcher.id, target };
    if (validateLaunch(believed, player, order).legal) orders.push(order);
  }
  return orders;
}

// ---------------------------------------------------------------------------
// The one export
// ---------------------------------------------------------------------------

/**
 * `player`'s orders for the round about to resolve, decided from `view` alone
 * (see the header — this is the whole contract). `rng` should be freshly
 * seeded per round by the caller (e.g. `makeRng(seed + round)`) so a match
 * replays identically at a fixed seed, matching the rest of this codebase's
 * determinism discipline even though `src/state/` is not bound by the sim's
 * stricter "no Math.random()" rule (CLAUDE.md).
 */
export function cpuOrders(
  view: VisibleGameState,
  difficulty: CpuDifficulty,
  player: PlayerId,
  rng: Rng,
): Order[] {
  if (view.phase === 'DEAD_HAND_PHASE') {
    // Spec §3: only the decapitated player orders anything this round: "the
    // opponent issues no orders at all."
    return view.deadHandFor === player ? deadHandOrders(view, difficulty, player, rng) : [];
  }

  const believed = believedState(view);
  const orders: Order[] = [];

  const launchers = view.units.filter((u) => u.kind === 'launcher' && !u.destroyed);
  if (launchers.length > 0) {
    const avoid = knownEnemyHexes(view);
    const targets = knownTargets(view);
    const targetRow = advanceRow(player);
    const danger = difficulty === 'hard' ? dangerHexes(view) : null;

    for (const launcher of launchers) {
      const order =
        difficulty === 'easy'
          ? easyLauncherOrder(believed, player, launcher, rng)
          : reactiveLauncherOrder(
              believed,
              player,
              launcher,
              targets,
              targetRow,
              avoid,
              danger,
              difficulty === 'hard',
            );
      if (order) orders.push(order);
    }
  }

  const drone = view.units.find((u) => u.kind === 'drone' && !u.destroyed);
  if (drone && view.droneRespawnIn === 0) {
    const order =
      difficulty === 'easy'
        ? easyDroneOrder(believed, player, drone, rng)
        : reactiveDroneOrder(believed, player, drone, advanceRow(player));
    if (order) orders.push(order);
  }

  return orders;
}
