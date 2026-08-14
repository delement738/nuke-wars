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
// "just for tuning" edit. `believedState` (now in `./belief`, shared with the
// human's order builder since build-order step 10a) turns that redacted view
// back into a `GameState`-shaped object containing ONLY what the player
// currently knows to exist (their own units; nothing standing in for an enemy),
// and every order this file proposes is checked against it with the SAME
// validators `resolve()` trusts — `validateMove`, `validateLaunch`,
// `validateFly`. Sharing that module with the UI is what makes "the CPU is bound
// by the same fog a human is" a shared import rather than a promise. That is
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
//   - HARD plays for the decapitation instead, with four concrete refinements:
//     once recon has found a bunker/decoy site it drives its launchers into
//     range of *that hex* rather than pushing at the front generically; it
//     **force-marches during that drive** and goes quiet once in position (see
//     `groundAdvanceOrder` — it is the only tier that ever pays a public reveal);
//     it then shoots the site in preference to a launcher contact that is also
//     in range (see `knownTargets` — this ordering is the opposite of the obvious
//     one and the comment there explains why, with the measurement that settled
//     it); and it prefers a reachable hex outside a known enemy launcher's range
//     over one further forward but exposed.
//
// MEDIUM and HARD share one recon behaviour, because searching the enemy home
// zone is not a difficulty setting — a drone that does not search is simply
// broken. Both fly the serpentine tour in `sweepLanes`.

import { RULES, UNIT_DEFS } from '../sim/defs';
import {
  axialToOffset,
  compareHex,
  distance,
  hexKey,
  hexesInRange,
  offsetToAxial,
  type Hex,
} from '../sim/hex';
import { tileAt } from '../sim/map';
import { validateLaunch } from '../sim/missiles';
import {
  groundBudget,
  reachableHexes,
  validateMarch,
  validateMove,
} from '../sim/movement';
import { validateFly } from '../sim/recon';
import {
  opponentOf,
  type GameState,
  type Order,
  type PlayerId,
  type Unit,
  type VisibleGameState,
} from '../sim/types';
import { believedState, knownEnemyHexes } from './belief';

export type CpuDifficulty = 'easy' | 'medium' | 'hard';

/** Matches `makeRng`'s return shape (`src/sim/map.ts`) without importing it —
 * the CPU is client state, not simulation, and owns its own RNG instance. */
export type Rng = () => number;

/** The row this player's LAUNCHERS advance toward: the near edge of the
 * opponent's home zone (spec §7) — as far as a launcher ever needs to go to
 * threaten it. P1 marches north out of rows 13–18 toward P2's zone (0–5), so
 * its target is that zone's high-numbered edge; P2 mirrors it toward P1's
 * low-numbered edge.
 *
 * **This is a launcher's goal, never the drone's.** The drone's job is to
 * search the whole zone, and stopping at its near edge would leave the far
 * five-sixths — and the bunker in it — unphotographed for the entire match.
 * See `sweepLanes`. */
function advanceRow(player: PlayerId): number {
  const opponentZone = RULES.homeZoneRows[opponentOf(player)];
  return player === 'p1' ? opponentZone.max : opponentZone.min;
}

// ---------------------------------------------------------------------------
// The recon sweep (medium & hard)
// ---------------------------------------------------------------------------

/**
 * A serpentine tour of waypoints that, walked in order, photographs the whole
 * of the opponent's home zone (spec §7, §11).
 *
 * Everything here is derived from `RULES` and the map width rather than written
 * down, so retuning a home zone, the swath radius or the drone's range moves the
 * lanes with it instead of silently leaving gaps:
 *
 *   - **Pass rows** are spaced `2 * reconSwathRadius + 1` apart, which is the
 *     width of the corridor one pass photographs, so consecutive passes cover
 *     adjacent strips with no seam between them. A 6-row zone at radius 1 needs
 *     exactly two passes.
 *   - **Lane columns** are spaced no wider than one flight, so every hop between
 *     consecutive waypoints completes in a single round. (Holding the row and
 *     moving N columns is exactly N hexes on this grid, so the drone's range is
 *     directly a column budget.)
 *   - **The order serpentines** — every other pass runs right-to-left — so each
 *     pass ends beside where the next one starts and no round is spent flying
 *     back across ground already photographed.
 *
 * The tour starts at the edge of the zone the drone arrives from, which is the
 * only place the player's own home zone is consulted.
 */
export function sweepLanes(player: PlayerId, width: number): Hex[] {
  const zone = RULES.homeZoneRows[opponentOf(player)];
  const own = RULES.homeZoneRows[player];
  const radius = RULES.reconSwathRadius;

  const band = 2 * radius + 1;
  const passes = Math.max(1, Math.ceil((zone.max - zone.min + 1) / band));
  const rows: number[] = [];
  for (let i = 0; i < passes; i++) {
    // Clamped so the final pass hugs the far edge rather than overshooting it
    // when the zone height is not a whole number of bands.
    rows.push(Math.min(zone.min + radius + i * band, zone.max - radius));
  }
  // Sweep from the near edge inward. Derived from the zones rather than from
  // `player === 'p1'` so it stays correct if the board is ever re-laid.
  if (own.min > zone.max) rows.reverse();

  // Lanes run edge to edge rather than inset by the swath radius. Insetting
  // looks right and is not: the swath spreads `radius` COLUMNS sideways, but on
  // staggered odd-q columns that spread is a diagonal, so a lane at column 1
  // reaches (0, row) and (0, row+1) while leaving (0, row-1) unphotographed.
  // Flying the edge itself costs nothing and removes the whole question.
  const steps = Math.max(1, Math.ceil((width - 1) / UNIT_DEFS.drone.movement));
  const cols: number[] = [];
  for (let i = 0; i <= steps; i++) {
    cols.push(Math.round(((width - 1) * i) / steps));
  }

  const lanes: Hex[] = [];
  rows.forEach((row, pass) => {
    const ordered = pass % 2 === 0 ? cols : [...cols].reverse();
    for (const col of ordered) lanes.push(offsetToAxial({ col, row }));
  });
  return lanes;
}

/**
 * The waypoint a drone at `from` should head for next — the whole of the sweep's
 * "memory", derived from position alone.
 *
 * `cpuOrders` is stateless by design (see the header), so the drone cannot
 * remember which lanes it has already flown. It does not need to: the tour is a
 * fixed cycle, so "where am I on it" is answered by *which waypoint I am nearest
 * to*, and the next one is the answer. That is self-correcting — a drone blown
 * off course, or one that respawned mid-tour, rejoins at whatever point of the
 * cycle it actually finds itself — and it re-sweeps forever once round, which is
 * what catches launchers that have relocated since the last pass.
 *
 * The range check is the inbound case. A drone still crossing neutral ground is
 * nearest to some lane it has not reached yet, and sending it to the one *after*
 * that would cut the corner and skip a lane on every trip out.
 */
export function nextSweepWaypoint(from: Hex, lanes: readonly Hex[]): Hex {
  let nearest = 0;
  for (let i = 1; i < lanes.length; i++) {
    if (distance(from, lanes[i]) < distance(from, lanes[nearest])) nearest = i;
  }
  if (distance(from, lanes[nearest]) > UNIT_DEFS.drone.movement) return lanes[nearest];
  return lanes[(nearest + 1) % lanes.length];
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
 * attacker: **a bunker/decoy site outranks a launcher contact.** MEDIUM ignores
 * the ranking entirely (see `selectTarget`) and fires at whichever is nearest,
 * contact or site alike.
 *
 * This ordering was REVERSED on 2026-08-13, and the reasoning is worth keeping
 * because the old way is the more obvious one. A contact is the better *shot*:
 * it is a certain kill, since an enemy launcher that fired cannot also have
 * moved (spec §11), where a site might be the decoy (§12). But it is the worse
 * *move*. The bunker is the win condition (§1) and killing launchers only ever
 * pays out as the consolation Disarmament; a site marker is permanent while the
 * range to shoot it from is not, so a HARD launcher that drove across the board
 * to reach a site and then spent its one order on a passing contact has thrown
 * away the whole maneuver. Contact-first also made HARD's site-seeking movement
 * fight itself, which is why the tier measured no stronger than MEDIUM.
 *
 * Measured, not assumed (`npm run soak`, 100 matches per pairing): flipping this
 * took HARD from 50–50 against MEDIUM to 58–49, and its mirror-match
 * decapitations from 36 to 45. It also gives the two tiers a coherent identity —
 * HARD plays for the decapitation the match is about, MEDIUM fights the front.
 */
function knownTargets(view: VisibleGameState): Target[] {
  const targets: Target[] = [];
  for (const contact of view.intel.contacts) {
    targets.push({ hex: contact.hex, priority: 1 });
  }
  for (const reveal of view.intel.staticReveals) {
    targets.push({ hex: reveal.hex, priority: 0 });
  }
  return targets;
}

/**
 * Hexes this player believes hold a bunker — which, after the visibility
 * filter's mask, means "a bunker or a decoy" (spec §12: the CPU is entitled to
 * exactly the same uncertainty a human is, and `VisibleStaticReveal.kind`
 * cannot express 'decoy' at all).
 *
 * Interceptor bases are excluded because a site is a thing worth *driving to*
 * and a base is not. In practice the list can never contain one anyway — the
 * radii make a base impossible to photograph (spec §11) — so the filter is
 * documentation as much as logic.
 */
function knownSites(view: VisibleGameState): Hex[] {
  return view.intel.staticReveals
    .filter((reveal) => reveal.kind === 'bunker')
    .map((reveal) => reveal.hex);
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
 * Where a launcher is trying to get to.
 *
 * Two shapes because the two tiers want genuinely different things, and
 * flattening them into one number would lose the distinction:
 *
 *   - `row` — MEDIUM's standing goal: push toward the near edge of the enemy
 *     home zone and fight whatever is there. Column-blind, which is why a
 *     MEDIUM launcher advances straight up the board.
 *   - `site` — HARD's goal once recon has found something: get within missile
 *     range of *that hex*. Scored as the distance still to cover, so every hex
 *     already in range scores 0 and the safety preference below becomes the
 *     tiebreak — the launcher closes to the edge of its reach and then prefers
 *     to sit somewhere the enemy cannot answer from.
 */
export type AdvanceGoal =
  | { kind: 'row'; row: number }
  | { kind: 'site'; site: Hex };

function advanceScore(hex: Hex, goal: AdvanceGoal): number {
  return goal.kind === 'row'
    ? Math.abs(axialToOffset(hex).row - goal.row)
    : Math.max(0, distance(hex, goal.site) - RULES.missileRange);
}

/**
 * The reachable hex making the most progress toward `goal`, never one in
 * `avoid` (a known enemy site).
 *
 * When `danger` is given (HARD only) and the single best hex sits inside it, a
 * safe hex is taken instead ONLY if it costs at most `SAFETY_DETOUR_TOLERANCE`
 * of extra progress — a short detour for safety is worth it (spec §3: "the safe
 * way to fire is from inside your own interceptor coverage or outside enemy
 * reach"), but refusing to advance at all over a one-hex risk would make HARD
 * more passive than MEDIUM, not smarter. If the best hex is itself safe, or no
 * safe alternative is close enough, it is simply taken.
 *
 * `mode` selects the ground budget through the sim's own `groundBudget`, so the
 * march's longer reach comes from the same function the validator uses rather
 * than from a second constant here (spec §9). Everything else — the goal, the
 * avoid set, the safety preference — is identical for a walk and a march,
 * because a march IS a walk on a bigger allowance.
 */
export function pickAdvanceDestination(
  believed: GameState,
  launcher: Unit,
  goal: AdvanceGoal,
  avoid: ReadonlySet<string>,
  danger: ReadonlySet<string> | null,
  mode: 'MOVE' | 'MARCH' = 'MOVE',
): Hex | null {
  let best: { hex: Hex; score: number; safe: boolean } | null = null;
  let bestSafe: { hex: Hex; score: number } | null = null;

  const budget = groundBudget(launcher, mode);

  for (const { hex } of reachableHexes(believed, launcher, budget).values()) {
    const key = hexKey(hex);
    if (key === hexKey(launcher.position)) continue; // SAME_HEX is illegal
    if (avoid.has(key)) continue;

    const score = advanceScore(hex, goal);
    const safe = !danger || !danger.has(key);

    if (!best || score < best.score) best = { hex, score, safe };
    if (safe && (!bestSafe || score < bestSafe.score)) bestSafe = { hex, score };
  }

  if (!best) return null;
  if (best.safe || !bestSafe) return best.hex;
  return bestSafe.score <= best.score + SAFETY_DETOUR_TOLERANCE ? bestSafe.hex : best.hex;
}

/**
 * The ground order a launcher gives when it is not firing: a MOVE, or a MARCH
 * when HARD judges the reveal worth paying (spec §9, §11).
 *
 * **When HARD marches: only to prosecute a known site, and only while the extra
 * budget actually buys progress.** Both halves of that rule matter.
 *
 *   - *Only toward a site.* A march trades position for tempo, and tempo is only
 *     worth buying when there is something to arrive at. Pushing at the front
 *     generically (MEDIUM's `row` goal) has no deadline, so paying a public
 *     reveal to get there a round sooner is a cost with no matching benefit —
 *     the launcher would be announcing its approach axis to buy nothing. Once
 *     recon has found a bunker/decoy site, the calculation inverts: there is a
 *     clock (`RULES.roundCap`), the site marker is permanent while the range to
 *     shoot it from is not, and ~41% of HARD mirror matches were still timing out
 *     in Armistice before this existed.
 *
 *   - *Only while it buys progress.* The test is simply whether the march
 *     destination scores better than the walk destination against the SAME goal.
 *     That one comparison gives the behaviour its shape for free, without a
 *     distance threshold to tune: `advanceScore` for a site goal is
 *     `max(0, distance - missileRange)`, so during the long approach a march
 *     gains real ground and is taken, and the moment the launcher is close
 *     enough that a walk already reaches firing range both score 0, the
 *     comparison fails, and it goes quiet. **HARD is loud while closing and
 *     silent once in position** — which is the tactically right shape, and it is
 *     emergent rather than written down.
 *
 * Returns the MOVE whenever the march is refused, so this never costs a round.
 *
 * **The site-only restriction was measured against the obvious alternative, and
 * kept for a reason the headline number argues against** (`npm run soak`, 100
 * matches per pairing, 2026-08-14). Letting HARD march toward the `row` goal as
 * well looks far stronger on tier separation — hard vs medium goes 61–52 to
 * 114–25 — but it is an artifact worth not shipping. The tell is that the gain
 * appears ONLY against MEDIUM: the hard MIRROR gets slightly worse (Armistice
 * 36 -> 41, mean rounds 13.3 -> 13.8), which is not what a genuinely better
 * policy does. What actually happens is that marching every round floods the
 * enemy with contacts on hexes the launcher has already left, and MEDIUM —
 * which has no `dangerHexes` and picks targets by distance alone, kind-blind —
 * spends its volleys on that empty ground. It measures as skill and is really
 * an opponent's blind spot. It also makes marching unconditional (200/200 sides
 * marched, 6.2 per side), which deletes the decision the rule exists to pose.
 *
 * Site-only, by contrast, improves the numbers this harness was built to watch:
 * Armistice 41 -> 36, mean rounds 14.2 -> 13.3, decapitations 45 -> 46, with
 * marching staying a judgement call (42/200 sides, 0.25 per side). Revisit if the
 * CPU ever learns that a march contact is a bearing rather than a target.
 */
function groundAdvanceOrder(
  believed: GameState,
  player: PlayerId,
  launcher: Unit,
  goal: AdvanceGoal,
  avoid: ReadonlySet<string>,
  danger: ReadonlySet<string> | null,
  mayMarch: boolean,
): Order | null {
  const walk = pickAdvanceDestination(believed, launcher, goal, avoid, danger, 'MOVE');

  if (mayMarch && goal.kind === 'site') {
    const march = pickAdvanceDestination(believed, launcher, goal, avoid, danger, 'MARCH');
    if (march && (!walk || advanceScore(march, goal) < advanceScore(walk, goal))) {
      const order: Order = { type: 'MARCH', unitId: launcher.id, destination: march };
      if (validateMarch(believed, player, order).legal) return order;
    }
  }

  if (!walk) return null;
  const order: Order = { type: 'MOVE', unitId: launcher.id, destination: walk };
  return validateMove(believed, player, order).legal ? order : null;
}

/**
 * One launcher's order for MEDIUM/HARD: fire on anything in range (ranked only
 * for HARD), otherwise advance toward `goal`.
 *
 * Firing is always preferred to moving, and unconditionally so — munitions are
 * unlimited (spec §2), so the only cost of a launch is the contact it files on
 * the defender's map (§11), and a shot that might kill something beats a hex of
 * progress that certainly does not. That ordering is also what keeps the march
 * policy honest: a launcher only ever marches on a round it had nothing to shoot
 * at, so going loud never costs a shot.
 */
function reactiveLauncherOrder(
  believed: GameState,
  player: PlayerId,
  launcher: Unit,
  targets: readonly Target[],
  goal: AdvanceGoal,
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

  // `ranked` IS the HARD flag (see `selectTarget`), and marching is a HARD-only
  // tool for the same reason ranking is: it is the tier that plays for the
  // decapitation, and the march exists to get there before the clock does.
  return groundAdvanceOrder(believed, player, launcher, goal, avoid, danger, ranked);
}

/**
 * The drone's order for MEDIUM/HARD: fly as far along the search tour as this
 * round's range allows (spec §11 — a straight line that ignores terrain and
 * units, so this is pure geometry and never the ground flood fill).
 *
 * Still stateless. The tour is fixed and `nextSweepWaypoint` reads the drone's
 * place on it off its own position, so nothing has to be remembered between
 * rounds — see the note there.
 */
function reactiveDroneOrder(
  believed: GameState,
  player: PlayerId,
  drone: Unit,
): Order | null {
  const waypoint = nextSweepWaypoint(
    drone.position,
    sweepLanes(player, believed.map.width),
  );

  const candidates = hexesInRange(drone.position, UNIT_DEFS.drone.movement).filter(
    (hex) => hexKey(hex) !== hexKey(drone.position) && onMap(believed.map, hex),
  );

  let best: { hex: Hex; score: number } | null = null;
  for (const hex of candidates) {
    const score = distance(hex, waypoint);
    // `compareHex` breaks ties so the choice cannot depend on the order
    // `hexesInRange` happens to enumerate in (the determinism discipline of
    // spec §6, applied to a client that is not bound by it but benefits from
    // being replayable).
    if (!best || score < best.score || (score === best.score && compareHex(hex, best.hex) < 0)) {
      best = { hex, score };
    }
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
    const fallback: AdvanceGoal = { kind: 'row', row: advanceRow(player) };
    const danger = difficulty === 'hard' ? dangerHexes(view) : null;
    // HARD prosecutes: once recon has found a site, its launchers drive to a
    // hex they can shoot it from instead of pushing at the front generically.
    // MEDIUM never does — that is the tier's whole distinction on the ground,
    // and it is why MEDIUM fights an attrition war it cannot win outright while
    // HARD plays for the decapitation the match is actually about (spec §1).
    const sites = difficulty === 'hard' ? knownSites(view) : [];

    for (const launcher of launchers) {
      const goal: AdvanceGoal =
        sites.length > 0
          ? { kind: 'site', site: nearestTo(sites, launcher.position) }
          : fallback;

      const order =
        difficulty === 'easy'
          ? easyLauncherOrder(believed, player, launcher, rng)
          : reactiveLauncherOrder(
              believed,
              player,
              launcher,
              targets,
              goal,
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
        : reactiveDroneOrder(believed, player, drone);
    if (order) orders.push(order);
  }

  return orders;
}
