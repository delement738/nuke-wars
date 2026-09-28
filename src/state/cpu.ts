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
//   - MEDIUM force-marches toward the enemy's home zone at the opening, then
//     fires at whichever known target — contact or site — is nearest, in
//     range, kind-blind.
//   - HARD plays for the decapitation instead, with four concrete refinements:
//     once recon has found a bunker/decoy site it drives its launchers into
//     range of *that hex* rather than pushing at the front generically (it
//     force-marches during that drive, as both tiers do on the opening advance,
//     and goes quiet once in position — see `groundAdvanceOrder`);
//     it then shoots the site in preference to a launcher contact that is also
//     in range (see `knownTargets` — this ordering is the opposite of the obvious
//     one and the comment there explains why, with the measurement that settled
//     it); it reads flight time (§10) — only shoots a launcher where the missile
//     will still find it, and gives a launcher that cannot escape an inbound
//     missile its last shot (see `hardFiringSolution`, `doomedLaunchers`); and it
//     prefers a reachable hex outside a known enemy launcher's undodgeable reach
//     over one further forward but exposed.
//
// MEDIUM and HARD share one recon behaviour, because searching the enemy home
// zone is not a difficulty setting — a drone that does not search is simply
// broken. Both fly the serpentine tour in `sweepLanes`, steering around every
// hex their own event log says a hidden base might cover (`droneDangerHexes`).
//
// **The one exception to "stateless": the player's own event log.** `cpuOrders`
// still remembers nothing it decided, but it may be handed the log its seat has
// received so far — the same permanent, filtered history a human reads in the
// HUD (spec §6). Without it the drone was re-flying the same route into the same
// bubble after every respawn: measured 2026-09-27, 180 of 273 HARD drone deaths
// (66%) were on a hex that drone had already died on. That is not a difficulty
// setting either; a human stops doing it after the first loss.

import { RULES, UNIT_DEFS } from '../sim/defs';
import {
  axialToOffset,
  compareHex,
  distance,
  hexKey,
  hexLine,
  hexesInRange,
  offsetToAxial,
  type Hex,
} from '../sim/hex';
import { firingPositions, lineOfFireClear, tileAt } from '../sim/map';
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
  type VisibleEvent,
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

/**
 * Every hex this player's drone should refuse to enter, read off its own event
 * history and its own intel — never anything a human in the seat could not see.
 *
 * The question is "where could the enemy's base be?", answered the way a human
 * would, and then "which hexes could a base there cover?":
 *
 *   - **A base we can see** (a static reveal of kind `interceptor`). Since the
 *     2026-09-27 redesign a base goes public the first time it intercepts one of
 *     our missiles (`BASE_EXPOSED`), so this is live. Its exact coverage,
 *     radius `R`, is danger, and it explains every drone death within `R` of it.
 *   - **A drone of ours was downed at hex H** that no known base explains. The
 *     killer is within `R` of H. Candidates are then pruned three ways, all from
 *     public or own-side facts: the hex must be on the board, inside the enemy's
 *     home zone (§12 — bases are placed there), and NOT within `R` of any hex our
 *     drone ever transmitted from (`DRONE_MOVED.path`), because a base there
 *     would have shot it down.
 *   - **Several unexplained deaths point at the same base** while each player
 *     has one (`RULES.placementCounts.interceptor`), so their candidate sets are
 *     intersected. At radius 2 that is the difference between a 61-hex no-fly
 *     blob per death and a region that shrinks with every clue. If the sets do
 *     not meet — which would mean more than one base — it falls back to their
 *     union rather than trust a wrong inference.
 *
 * A clue is dropped once an enemy base is publicly destroyed within `R` of it:
 * with one base per side, that was the base.
 *
 * Only `DRONE_DOWNED` events naming `player` count: the event is public, and the
 * enemy's drone dying over our own base says nothing about theirs.
 */
export function droneDangerHexes(
  view: VisibleGameState,
  history: readonly VisibleEvent[],
  player: PlayerId,
): Set<string> {
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
    if (
      event.type === 'UNIT_DESTROYED' &&
      event.kind === 'interceptor' &&
      !view.units.some((u) => u.id === event.unitId)
    ) {
      deadBases.push(event.hex);
    }
  }

  const knownBases = view.intel.staticReveals
    .filter((reveal) => reveal.kind === 'interceptor')
    .map((reveal) => reveal.hex);

  const danger = new Set<string>();
  for (const base of knownBases) {
    for (const hex of hexesInRange(base, R)) danger.add(hexKey(hex));
  }

  const explained = [...knownBases, ...deadBases];
  const clues = deaths.filter((death) => !explained.some((b) => distance(b, death) <= R));
  if (clues.length === 0) return danger;

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

  let candidates = [...candidateSets[0].values()];
  if (RULES.placementCounts.interceptor === 1) {
    const shared = candidates.filter((h) =>
      candidateSets.every((set) => set.has(hexKey(h))),
    );
    if (shared.length > 0) candidates = shared;
    else candidates = candidateSets.flatMap((set) => [...set.values()]);
  } else {
    candidates = candidateSets.flatMap((set) => [...set.values()]);
  }

  for (const base of candidates) {
    for (const hex of hexesInRange(base, R)) danger.add(hexKey(hex));
  }
  return danger;
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
 * contact or site alike. Since flight time HARD fires through
 * `hardFiringSolution`, which keeps this site-first rule and adds range tiers
 * for contacts; the reasoning below is still why sites come first.
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
  // Exposed interceptor bases are NOT single-launcher targets: one missile at a
  // base always crosses its own bubble and is always intercepted (§10, gotcha
  // 23). They are fired on only as a volley — see `baseVolley`.
  for (const reveal of view.intel.staticReveals) {
    if (reveal.kind === 'interceptor') continue;
    targets.push({ hex: reveal.hex, priority: 0 });
  }
  return targets;
}

/**
 * Launchers that should fire at an exposed enemy base this round, and where.
 *
 * A base is self-protecting: a missile aimed at it must cross its coverage, so
 * a lone shot is always intercepted (§10, gotcha 23). The counter is saturation
 * — `RULES.interceptsPerRound + 1` missiles in one round, the first spent on the
 * intercept and the rest landing. So a base is attacked only when that many
 * launchers can reach it this round, and then exactly that many fire, nearest
 * first (id as the tiebreak, so the choice is deterministic). Everyone else is
 * left free to shoot at something else.
 *
 * Taking priority over a site shot is deliberate. The kill is permanent, it
 * opens every lane the base covered, and before the redesign bases were never
 * visible so this could not happen at all (bases killed: 0.01 per side).
 */
function baseVolley(
  view: VisibleGameState,
  launchers: readonly Unit[],
): Map<string, Hex> {
  const volley = new Map<string, Hex>();
  const needed = RULES.interceptsPerRound + 1;

  for (const reveal of view.intel.staticReveals) {
    if (reveal.kind !== 'interceptor') continue;
    const inRange = launchers
      .filter((l) => !volley.has(l.id))
      .filter((l) => canFire(view.map, l.position, reveal.hex))
      .sort(
        (a, b) =>
          distance(a.position, reveal.hex) - distance(b.position, reveal.hex) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    if (inRange.length < needed) continue;
    for (const launcher of inRange.slice(0, needed)) volley.set(launcher.id, reveal.hex);
  }
  return volley;
}

/**
 * Hexes this player believes hold a bunker — which, after the visibility
 * filter's mask, means "a bunker or a decoy" (spec §12: the CPU is entitled to
 * exactly the same uncertainty a human is, and `VisibleStaticReveal.kind`
 * cannot express 'decoy' at all).
 *
 * Interceptor bases are excluded because a site is a thing worth *driving to*
 * and a base is not. Since 2026-09-27 a base does appear here once it has
 * intercepted one of our missiles (`BASE_EXPOSED`), so the filter is live.
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

// ---------------------------------------------------------------------------
// Flight time (hard) — spec §3, §10
// ---------------------------------------------------------------------------

/**
 * HARD's firing solution for one launcher, or none. Replaces `selectTarget`'s
 * ranking for HARD since a shot at range 5–6 lands a round late (§10), which
 * made the question "will the target still be there?" part of every shot:
 *
 *   1. **A site, at any range.** Bunkers and decoys cannot move, so flight time
 *      costs a site shot nothing, and the 2026-08-13 site-first ranking stands.
 *   2. **A RECON or LAUNCH contact at range ≤ `missileSpeed`.** It lands in
 *      phase 3, before the target's move (§3), so it cannot be dodged.
 *   3. **A LAUNCH contact at 5–6.** A launcher that fired last round is likely
 *      still firing, and so still there.
 *
 * Two shots are deliberately never taken. A **march contact** is the hex the
 * launcher left (§11), so it is empty by construction. A **recon contact at 5–6**
 * has a launcher that is moving now and will move again before impact. Every
 * launch files a contact on the enemy's map, so a speculative shot is not free:
 * it anchors the firer for counter-battery.
 *
 * **Leading the target was tried and REJECTED** (2026-09-27,
 * `SOAK_MATCHES=60`, hard vs medium, seeds 3/7/11). Aiming one forced march
 * ahead of a moving contact, toward the enemy's goal row, took seed 3 from
 * 50–38 to 36–55. Led shots at march contacts were the costly part (−15 wins
 * on every seed): marches are frequent, so HARD fired constantly, stopped
 * advancing, and lost the counter-battery war (HARD launchers lost per match
 * 1.0 → 2.5). Led shots at recon contacts alone changed nothing, because the
 * led hex almost never lands in the 5–6 band. The tiers above gave
 * 50→53, 49→54, 48→53 on the same three seeds.
 *
 * Every tier is filtered by `canFire`, so a target behind a ridge (§10) is
 * simply not a solution, and the launcher advances toward a lane instead.
 *
 * Nearest wins within a tier.
 */
export function hardFiringSolution(view: VisibleGameState, from: Hex): Hex | undefined {
  const reach = (hex: Hex) => distance(from, hex);
  const sites = knownSites(view).filter((hex) => canFire(view.map, from, hex));
  const short: Hex[] = [];
  const long: Hex[] = [];
  for (const contact of view.intel.contacts) {
    const d = reach(contact.hex);
    if (contact.source === 'MARCH' || !canFire(view.map, from, contact.hex)) continue;
    if (d <= RULES.missileSpeed) short.push(contact.hex);
    else if (contact.source === 'LAUNCH') long.push(contact.hex);
  }
  for (const tier of [sites, short, long]) {
    if (tier.length > 0) return nearestTo(tier, from);
  }
  return undefined;
}

/**
 * Own launchers standing on the target hex of a missile already in the air.
 *
 * **They cannot dodge it, and that is why this exists.** Every missile in
 * `view.missiles` has already flown `missileSpeed` hexes and lands in phase 3 of
 * the round being ordered now — before phase 5, where any move would happen
 * (§3). A move is wasted; so is the round's order, unless it is a launch: the
 * launcher fires in phase 2 before the impact, and the missile flies on after it
 * dies (§10, fire-and-forget). So a doomed launcher's only useful act is its last
 * shot. The dodge that does work is the blind one, in the round the enemy fires,
 * which no warning can inform.
 */
export function doomedLaunchers(view: VisibleGameState): Set<string> {
  const targets = new Set(view.missiles.map((m) => hexKey(m.target)));
  return new Set(
    view.units
      .filter((u) => u.kind === 'launcher' && !u.destroyed && targets.has(hexKey(u.position)))
      .map((u) => u.id),
  );
}

/**
 * A doomed launcher's last shot: its normal firing solution if it has one, or
 * else a blind shot into the enemy home zone, at a hex no drone of ours has
 * photographed (a bunker or decoy there would already be a site). Firing costs
 * nothing — the launch contact it files is on a hex about to be empty.
 */
function lastShot(
  believed: GameState,
  view: VisibleGameState,
  player: PlayerId,
  launcher: Unit,
  history: readonly VisibleEvent[],
  rng: Rng,
): Order | null {
  let target = hardFiringSolution(view, launcher.position);
  if (!target) {
    const seen = new Set<string>();
    for (const event of history) {
      if (event.type !== 'DRONE_MOVED' || event.owner !== player) continue;
      for (const hex of event.path) {
        for (const near of hexesInRange(hex, RULES.reconSwathRadius)) seen.add(hexKey(near));
      }
    }
    const zone = RULES.homeZoneRows[opponentOf(player)];
    const candidates = hexesInRange(launcher.position, RULES.missileRange).filter((hex) => {
      if (!onMap(believed.map, hex) || seen.has(hexKey(hex))) return false;
      if (!canFire(believed.map, launcher.position, hex)) return false;
      const { row } = axialToOffset(hex);
      return row >= zone.min && row <= zone.max;
    });
    target = pickRandom(candidates, rng);
  }
  if (!target) return null;
  const order: Order = { type: 'LAUNCH', unitId: launcher.id, target };
  return validateLaunch(believed, player, order).legal ? order : null;
}

/** Hexes within `missileSpeed` of a known enemy launcher contact — HARD's
 * movement avoids ending a move here when an equally good alternative exists.
 * Every contact source is treated as live risk; a RECON contact may already
 * be one round stale (§11), but that is a reason to be less SURE the danger
 * is real, not a reason a heuristic this simple should ignore it.
 *
 * The radius was `missileRange` until flight time (§10). A shot from 5–6 lands
 * after the target's next move, and a HARD launcher that is not firing is
 * always moving, so only the ≤ 4 band is a threat it cannot walk out of.
 * Measured with `hardFiringSolution`, hard vs medium, seeds 3/7/11: 53→54,
 * 54→55, 53→54.
 *
 * Only hexes the contact has a clear line to (§10, 2026-09-28): a hex behind a
 * ridge from the contact cannot be hit from it, so it is cover, not danger.
 * Measured on top of line of fire, `SOAK_MATCHES=60`, seeds 3/7/11: hard vs
 * medium 53–27 / 52–26 / 51–25 → 56–26 / 54–26 / 53–24, hard mirror unchanged
 * (Armistice 9 / 9 / 8 both ways), hard vs easy 94 / 94 / 96 → 91 / 91 / 93
 * (still no losses). */
export function dangerHexes(view: VisibleGameState): Set<string> {
  const danger = new Set<string>();
  for (const contact of view.intel.contacts) {
    for (const hex of hexesInRange(contact.hex, RULES.missileSpeed)) {
      if (lineOfFireClear(view.map, contact.hex, hex)) danger.add(hexKey(hex));
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

/**
 * Whether a launcher on `from` could legally fire at `target` on terrain
 * alone: in range, not its own hex, and a clear line (§10). The CPU's every
 * "can I shoot that?" question goes through here, so none of them can still
 * mean "is it within 6?" — which since line of fire is only half the answer.
 * `validateLaunch` stays the final word on every order.
 */
function canFire(map: GameState['map'], from: Hex, target: Hex): boolean {
  const d = distance(from, target);
  return d > 0 && d <= RULES.missileRange && lineOfFireClear(map, from, target);
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
 *   - `site` — HARD's goal once recon has found something: get to a hex it
 *     can actually shoot *that hex* from. `firingHexes` is `firingPositions`
 *     for the site — in range AND a clear line (§10) — and the score is the
 *     distance to the nearest of them, so every firing hex scores 0 and the
 *     safety preference below becomes the tiebreak.
 *
 * Before line of fire (2026-09-28) the site score was `max(0, distance − 6)`,
 * the distance to the edge of the range disk. On a board with no mountains the
 * two are the same number; with a ridge in the way the old one parks the
 * launcher behind it at range 6 forever.
 */
export type AdvanceGoal =
  | { kind: 'row'; row: number }
  | { kind: 'site'; site: Hex; firingHexes: readonly Hex[] };

/** A `site` goal for `site` on this map — see `AdvanceGoal`. */
export function siteGoal(map: GameState['map'], site: Hex): AdvanceGoal {
  return { kind: 'site', site, firingHexes: firingPositions(map, site) };
}

function advanceScore(hex: Hex, goal: AdvanceGoal): number {
  if (goal.kind === 'row') return Math.abs(axialToOffset(hex).row - goal.row);
  // No lane at all cannot happen for a home-zone site on a generated board
  // (`NO_FIRING_LANE`), but a hand-built test map can do it; fall back to the
  // range disk rather than scoring every hex Infinity.
  if (goal.firingHexes.length === 0) {
    return Math.max(0, distance(hex, goal.site) - RULES.missileRange);
  }
  let best = Infinity;
  for (const lane of goal.firingHexes) best = Math.min(best, distance(hex, lane));
  return best;
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
 * whenever the march buys progress (spec §9, §11). MEDIUM and HARD both march;
 * EASY never reaches this function.
 *
 * **The rule: march while the extra budget actually buys progress toward the
 * goal.** The test is simply whether the march destination scores better than
 * the walk destination against the SAME goal, which gives the behaviour its
 * shape without a distance threshold to tune. For the `row` goal that means the
 * launchers force-march out of their home zone at the start of the match and go
 * quiet once they reach the front (both destinations score 0 there). For a
 * `site` goal, `advanceScore` is the distance to the nearest clear firing hex
 * (§10), so the launcher is loud while closing and silent once a walk already
 * reaches a lane. Either way the loud phase is the approach, which is the tactically
 * right shape, and it is emergent rather than written down.
 *
 * Returns the MOVE whenever the march is refused, so this never costs a round.
 *
 * **History, because this rule was once rejected.** Until 2026-09-27 the march
 * was HARD-only and site-only: on 2026-08-14, letting HARD alone march toward
 * the `row` goal took hard vs medium from 61–52 to 114–25 while the hard MIRROR
 * got slightly worse. That gain came from an opponent's blind spot: marching
 * floods the enemy with contacts on hexes the launcher has already left, and
 * MEDIUM spent its volleys on the empty ground. On 2026-09-27 (after drone
 * memory and the interceptor redesign; `SOAK_MATCHES=60 SOAK_SEED=3`) the
 * designer asked for a more aggressive opening, so it was re-measured. HARD-only
 * row marching still reproduced the artifact (hard vs medium 53–41 -> 85–21).
 * Giving MEDIUM the march too removes it, and every mirror improves or holds:
 * hard mirror decapitations 46 -> 49 (Armistice 6 -> 7), medium mirror
 * decapitations 37 -> 41 (Armistice 15 -> 14), hard vs medium 58–38, medium vs
 * easy 100–0 -> 111–0. The cost the old note named still applies: every
 * CPU side now marches (~6 per side per match), so for the CPU the opening march
 * is a habit, not a judgement call. What is still a judgement call is when to
 * STOP being loud.
 */
function groundAdvanceOrder(
  believed: GameState,
  player: PlayerId,
  launcher: Unit,
  goal: AdvanceGoal,
  avoid: ReadonlySet<string>,
  danger: ReadonlySet<string> | null,
): Order | null {
  const walk = pickAdvanceDestination(believed, launcher, goal, avoid, danger, 'MOVE');

  const march = pickAdvanceDestination(believed, launcher, goal, avoid, danger, 'MARCH');
  if (march && (!walk || advanceScore(march, goal) < advanceScore(walk, goal))) {
    const order: Order = { type: 'MARCH', unitId: launcher.id, destination: march };
    if (validateMarch(believed, player, order).legal) return order;
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
  view: VisibleGameState,
): Order | null {
  const aim = ranked
    ? hardFiringSolution(view, launcher.position)
    : selectTarget(
        targets.filter((t) => canFire(believed.map, launcher.position, t.hex)),
        launcher.position,
        false,
      )?.hex;
  if (aim) {
    const order: Order = { type: 'LAUNCH', unitId: launcher.id, target: aim };
    if (validateLaunch(believed, player, order).legal) return order;
  }

  return groundAdvanceOrder(believed, player, launcher, goal, avoid, danger);
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
  danger: ReadonlySet<string>,
): Order | null {
  // Waypoints inside known danger are unreachable without dying, so the tour
  // skips them. If every waypoint is suspect (never, at shipped numbers) the
  // full tour is kept rather than grounding the drone for the match.
  const tour = sweepLanes(player, believed.map.width);
  const safeTour = tour.filter((hex) => !danger.has(hexKey(hex)));
  const waypoint = nextSweepWaypoint(drone.position, safeTour.length > 0 ? safeTour : tour);

  // A destination is safe only if its whole flight is: coverage kills on
  // ENTRY to any hex (spec §10), so the path is checked, not the endpoint. The
  // start hex is exempt — a drone is never killed where it already hovers.
  const flightIsSafe = (hex: Hex): boolean =>
    hexLine(drone.position, hex)
      .slice(1)
      .every((step) => !danger.has(hexKey(step)));

  const candidates = hexesInRange(drone.position, UNIT_DEFS.drone.movement).filter(
    (hex) =>
      hexKey(hex) !== hexKey(drone.position) && onMap(believed.map, hex) && flightIsSafe(hex),
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
  // No safe flight at all: hover. Hovering is always safe (coverage kills on
  // entry only) and still photographs this hex's corridor (spec §11).
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
    (hex) => onMap(believed.map, hex) && canFire(believed.map, launcher.position, hex),
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
  // Bunker sites only: an exposed base can be on the map now (`BASE_EXPOSED`),
  // and killing it cannot change the verdict — only the real bunker can.
  const staticTargets = view.intel.staticReveals
    .filter((r) => r.kind === 'bunker')
    .map((r) => r.hex);
  const opponent = opponentOf(player);
  const zone = RULES.homeZoneRows[opponent];

  const orders: Order[] = [];
  for (const launcher of launchers) {
    const inRange = staticTargets.filter((hex) =>
      canFire(believed.map, launcher.position, hex),
    );

    let target: Hex | undefined;
    if (inRange.length > 0) {
      target =
        difficulty === 'easy' ? pickRandom(inRange, rng) : nearestTo(inRange, launcher.position);
    } else {
      const candidates = hexesInRange(launcher.position, RULES.missileRange).filter(
        (hex) => onMap(believed.map, hex) && canFire(believed.map, launcher.position, hex),
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
 *
 * `history` is this seat's own filtered event log so far — exactly what
 * `filterEventsForPlayer` has handed that player, never the raw log. It defaults
 * to empty ("remembers nothing"), which is what unit tests of a single round
 * want; every caller playing a real match MUST pass it, or the drone goes back
 * to dying on the same hex (the soak harness's repeat-death line is the check).
 */
export function cpuOrders(
  view: VisibleGameState,
  difficulty: CpuDifficulty,
  player: PlayerId,
  rng: Rng,
  history: readonly VisibleEvent[] = [],
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

    const volley = difficulty === 'easy' ? new Map<string, Hex>() : baseVolley(view, launchers);
    const doomed = difficulty === 'hard' ? doomedLaunchers(view) : new Set<string>();

    for (const launcher of launchers) {
      if (doomed.has(launcher.id) && !volley.has(launcher.id)) {
        const order = lastShot(believed, view, player, launcher, history, rng);
        if (order) orders.push(order);
        continue;
      }

      const volleyTarget = volley.get(launcher.id);
      if (volleyTarget) {
        const order: Order = { type: 'LAUNCH', unitId: launcher.id, target: volleyTarget };
        if (validateLaunch(believed, player, order).legal) {
          orders.push(order);
          continue;
        }
      }

      const goal: AdvanceGoal =
        sites.length > 0 ? siteGoal(view.map, nearestTo(sites, launcher.position)) : fallback;

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
              view,
            );
      if (order) orders.push(order);
    }
  }

  const drone = view.units.find((u) => u.kind === 'drone' && !u.destroyed);
  if (drone && view.droneRespawnIn === 0) {
    const order =
      difficulty === 'easy'
        ? easyDroneOrder(believed, player, drone, rng)
        : reactiveDroneOrder(believed, player, drone, droneDangerHexes(view, history, player));
    if (order) orders.push(order);
  }

  return orders;
}
