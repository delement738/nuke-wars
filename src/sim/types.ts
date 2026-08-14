// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// Core data shapes for the simulation engine (docs/nuke-wars-v1-spec.md §6,
// §11, §12; build-order step 2 — the pivot migration). These are the
// vocabulary resolve() will operate on:
//   resolve(state: GameState, ordersP1: Order[], ordersP2: Order[], seed: number)
//     -> { state: GameState, events: GameEvent[] }
//
// The `seed` parameter is kept for forward compatibility only. V1 combat reads
// no randomness at all (spec §6) — don't plumb an RNG in here.
//
// Positions use axial hex coordinates (Hex, from ./hex) — not the map's
// render-side col/row offset coordinates (TileData, from ./map). The sim
// reasons in the coordinate system distance()/neighbors()/hexesInRange()
// already understand.

import type { Hex } from './hex';
import type { MapData } from './map';

export type PlayerId = 'p1' | 'p2';

/**
 * The two players, in canonical iteration order.
 *
 * A runtime value in a types module, deliberately. "There are exactly two
 * players" is the same fact as `PlayerId` above, and every module that iterates
 * them — resolve(), outcomes.ts, and the visibility filter in build-order step 8
 * — must iterate them in the SAME order, or the event log stops being
 * byte-identical for the same physical round (spec §6). One shared constant
 * makes that true by construction instead of by three modules agreeing.
 */
export const PLAYERS: readonly PlayerId[] = ['p1', 'p2'];

/**
 * The other player.
 *
 * Small enough to inline and load-bearing enough not to. Intel is keyed by the
 * *viewer* — `intel.p1` is what p1 knows about p2 — so a hand-written
 * `player === 'p1' ? 'p2' : 'p1'` written in the wrong direction files every
 * contact against the player who caused it. That is the §11 trap that would give
 * each player a map of their own launches and hide the enemy's, and it looks
 * perfectly reasonable in a diff. One function, used everywhere, cannot drift.
 */
export function opponentOf(player: PlayerId): PlayerId {
  return player === 'p1' ? 'p2' : 'p1';
}

export type UnitId = string;

/** The five unit kinds in V1's roster (spec §2). 8 assets per player total. */
export type UnitKind =
  | 'launcher'
  | 'interceptor'
  | 'drone'
  | 'bunker'
  | 'decoy';

/**
 * The kinds that cannot move, and are therefore revealed *permanently* once
 * detected (spec §11 rule 3). Mobility is the only thing that decides how long
 * a sighting lasts, so this union is the rule expressed as a type.
 */
export type StaticKind = 'interceptor' | 'bunker' | 'decoy';

/**
 * What an *enemy* is ever told a static asset is. Note 'decoy' is absent by
 * construction: a spotted decoy is reported as a bunker (spec §12's
 * indistinguishability principle), so the visibility filter's output type
 * literally cannot express the truth it is masking. The filter lands in
 * build-order step 8; this type is what it will return.
 */
export type MaskedStaticKind = 'interceptor' | 'bunker';

/**
 * A missile in flight, identified for one round.
 *
 * Derived from public data only — round number plus the origin hex, which
 * `LAUNCH_DETECTED` already publishes to both players. That matters: it lets
 * MISSILE_INTERCEPTED and IMPACT say *which* missile they refer to (so the
 * client can animate from events rather than guess) while leaking nothing
 * about the firing launcher's identity. A launcher fires at most one missile
 * per round and no two launchers share a hex, so this is unique.
 */
export type MissileId = string;

/**
 * A single piece on the board. Deliberately one generic shape rather than a
 * subtype per kind — per-kind stats live in UNIT_DEFS keyed by `kind`
 * (CLAUDE.md's data-table rule), never as fields here.
 *
 * `hp` is current health only; max health comes from UNIT_DEFS. Post-pivot
 * those numbers are settled (spec §7): bunker 2, everything else 1, drone n/a
 * — a drone is never damaged, only destroyed outright.
 */
export interface Unit {
  id: UnitId;
  owner: PlayerId;
  kind: UnitKind;
  position: Hex;
  hp: number;
  destroyed: boolean;
}

/**
 * A player's queued intent for one round.
 *
 * There is no per-round order budget in V1 — instead every living asset may
 * receive at most one order (`RULES.ordersPerUnit`, spec §3/§9). That is what
 * makes move-XOR-launch structural: a launcher's single order is either MOVE
 * or LAUNCH, never both. Only launchers and the drone are orderable; bunkers,
 * decoys, and interceptor bases are permanently static and act passively.
 */
export type Order =
  | { type: 'MOVE'; unitId: UnitId; destination: Hex }
  /**
   * A forced march: the same ground move on a bigger budget
   * (`RULES.forcedMarchMovement`), paid for by going loud (spec §9, §11).
   *
   * The launcher's *origin* hex is detected automatically and unsuppressably,
   * exactly like a launch — forced marching is the second loud action in the
   * game. What the enemy gets is deliberately weaker than a launch contact
   * though: a launcher that fired cannot also have moved, so a launch origin is
   * a live target, while a march origin is a hex its owner has by definition
   * just left. They learn your axis of advance, not your position.
   *
   * A distinct order type rather than `MOVE { forced: true }` because everything
   * in this engine discriminates on `type`, and because the client's `OrderMode`
   * is derived as `Order['type']` — a new variant flows through to the UI's mode
   * union instead of hiding inside a boolean every switch has to re-test.
   */
  | { type: 'MARCH'; unitId: UnitId; destination: Hex }
  /**
   * Blind fire is legal (spec §3): the target hex need not contain anything
   * the player can see. It must simply be on the map, within range 6, and not
   * the launcher's own hex.
   */
  | { type: 'LAUNCH'; unitId: UnitId; target: Hex }
  /** Straight-line drone flight, destination within 6 (spec §11). */
  | { type: 'FLY'; unitId: UnitId; destination: Hex };

/** Narrowed to the MOVE variant — the input shape the movement engine takes. */
export type MoveOrder = Extract<Order, { type: 'MOVE' }>;

/** Narrowed to the MARCH variant (spec §9). */
export type MarchOrder = Extract<Order, { type: 'MARCH' }>;

/**
 * The two orders resolved by phase 5 — one shape, two budgets.
 *
 * They are deliberately interchangeable everywhere except the budget and the
 * reveal: a march is subject to the same terrain, the same occupancy rule and
 * the same standoff adjudication as a walk (spec §9). Anything that treats them
 * differently beyond those two things is adding a rule the spec does not have.
 */
export type GroundOrder = MoveOrder | MarchOrder;

/** Narrowed to the FLY variant — the input shape the recon engine takes. */
export type FlyOrder = Extract<Order, { type: 'FLY' }>;

/** Narrowed to the LAUNCH variant — the input shape the missile engine takes. */
export type LaunchOrder = Extract<Order, { type: 'LAUNCH' }>;

export type GamePhase =
  | 'SETUP'
  | 'ORDER_PHASE'
  | 'RESOLUTION'
  | 'DEAD_HAND_PHASE'
  | 'GAME_OVER';

/** Spec §4's outcome table, in priority order. */
export type Outcome =
  | { type: 'MUTUAL_ANNIHILATION' }
  | { type: 'DECAPITATION'; winner: PlayerId }
  | { type: 'CAPITULATION'; winner: PlayerId }
  | { type: 'MUTUAL_DISARMAMENT' }
  | { type: 'DISARMAMENT'; winner: PlayerId }
  | { type: 'ARMISTICE' };

// ---------------------------------------------------------------------------
// Intel (spec §11)
// ---------------------------------------------------------------------------
//
// The four detection rules in one place: the map is public; only the recon
// swath and automatic launch detection reveal enemy assets; a launcher
// sighting lasts one round while a static sighting is permanent; and no
// detection distinguishes the real bunker from the decoy.
//
// Intel is therefore stored in two piles with different lifetimes. Note both
// are keyed by *hex*, never by unit id — you learn a place, not an identity.
// That is deliberate: it makes cross-round tracking of a specific enemy
// launcher impossible even for a modified client, the same way MOVE_FAILED is
// leak-proof by carrying no enemy-derived data (spec §9).

/**
 * A static asset seen by recon. Permanent — it cannot move, so the sighting
 * stays true until the asset is publicly destroyed, at which point resolve()
 * removes it.
 *
 * `kind` holds the TRUTH, including 'decoy'. resolve() never lies; the
 * visibility filter applies the decoy -> bunker mask on the way out and is the
 * only layer permitted to know the difference (spec §6, §12).
 */
export interface StaticReveal {
  hex: Hex;
  kind: StaticKind;
  /** Round it was first seen — UI flavour ("spotted round 4"), not a rule. */
  round: number;
}

/**
 * An enemy launcher seen this round, by recon swath or by launch detection.
 *
 * Lives for exactly one order phase. resolve() clears this list at the top of
 * every resolution and rebuilds it from that round's detections — there is no
 * expiry bookkeeping to get wrong, and no persistent "last seen" ghost marker
 * (cut deliberately, spec §11).
 */
export interface LauncherContact {
  hex: Hex;
  /**
   * How it was spotted, and with it how much the hex is worth (spec §11).
   *
   * - **RECON** — *may* already be stale. Recon flies in phase 1 and launchers
   *   move in phase 5 of the same round, so the launcher photographed here may
   *   have driven off before you ever issue an order. Shooting at one is a bet.
   * - **LAUNCH** — cannot be stale. A launcher that fired could not also move,
   *   and counter-battery missiles land in phase 3, before movement (§3). A live
   *   target for exactly one round, which is what makes firing a commitment.
   * - **MARCH** — is stale *by construction*, and is the only source that says so
   *   outright. The launcher announced a forced march and left; it is somewhere
   *   within `RULES.forcedMarchMovement` of this hex and certainly not on it. A
   *   bearing, not a target — and a hex its owner may have vacated deliberately
   *   to draw a counter-battery volley into empty ground.
   */
  source: 'RECON' | 'LAUNCH' | 'MARCH';
}

/** One player's picture of the enemy. */
export interface PlayerIntel {
  staticReveals: StaticReveal[];
  contacts: LauncherContact[];
}

/**
 * The single source of truth resolve() operates on — the *full* state, both
 * players' true positions, unfiltered. filterForPlayer() (build-order step 8)
 * derives what each player is allowed to see from this, per the spec §11
 * detection rules and the §6 event visibility table.
 */
export interface GameState {
  round: number;
  phase: GamePhase;
  map: MapData;
  units: Unit[];
  /** Keyed by the *viewing* player: `intel.p1` is what p1 knows about p2. */
  intel: Record<PlayerId, PlayerIntel>;
  /**
   * Rounds until a downed drone returns (spec §11). 0 = the drone is alive.
   * Set to 2 on death, decremented at the start of each order phase, and the
   * replacement spawns at the fixed drone spawn hex when it reaches 0 — which
   * gives exactly one full blind round in between. Respawns are unlimited.
   */
  droneRespawnIn: Record<PlayerId, number>;
  /** Whose final retaliation round is running, when phase is DEAD_HAND_PHASE. */
  deadHandFor: PlayerId | null;
  outcome: Outcome | null;
}

/**
 * Ordered log resolve() emits alongside the new GameState. Clients animate
 * from this, never by diffing before/after state (CLAUDE.md's event-log rule).
 * Also doubles as the replay format.
 *
 * Every event's audience is fixed by the spec §6 visibility table, and
 * filterEventsForPlayer() enforces it. resolve() always emits the truth to
 * both — the filter is the only thing that hides or masks. The log is
 * append-only and permanent: map contacts expire after a round, log entries
 * never do, which is what gives a player the full history of every launch
 * they have detected (spec §11).
 *
 * **Every owner-only event carries `owner` explicitly.** The filter's signature
 * is `filterEventsForPlayer(events, playerId)` (spec §6) — it is handed the log
 * and nothing else, so it cannot look a `unitId` up in a `GameState` to find out
 * whose event this is. A `UnitId` is an opaque string by design (nothing may
 * derive meaning from it, §6's note on missile ids), so the audience has to be
 * stated on the event itself or the filter cannot route it at all. This leaks
 * nothing: the only player who ever receives one of these is the owner, who
 * knows their own units. `DRONE_DOWNED` set this precedent — it is public, and
 * carries `owner` because the *content* names a player.
 */
export type GameEvent =
  // --- Owner only -----------------------------------------------------------
  | { type: 'UNIT_MOVED'; unitId: UnitId; owner: PlayerId; from: Hex; to: Hex }
  /**
   * A MOVE order that did not happen — the destination was blocked by a unit
   * the player couldn't see, or two units bounced off the same hex (spec §9).
   *
   * Deliberately carries nothing but the mover's own id and side: no
   * destination, no blocker, no reason code. That makes a standoff
   * byte-identical to being blocked by a stationary enemy, so the player cannot
   * tell whether someone was parked on that hex or raced them to it — two facts
   * with very different tactical meaning. The event is leak-proof by
   * construction rather than by policy: both fields describe the *recipient's
   * own* unit, so there is no enemy-derived data here for a future change to
   * widen.
   */
  | { type: 'MOVE_FAILED'; unitId: UnitId; owner: PlayerId }
  /**
   * Non-lethal bunker damage — the real bunker taking 1 of its 2 hits.
   *
   * Owner only, and load-bearing: to the attacker this is indistinguishable
   * from hitting empty ground. A decoy never emits it (it dies to that hit),
   * so *silence after a hit* is exactly what identifies the real bunker
   * (spec §6, §12).
   */
  | {
      type: 'BUNKER_HIT';
      unitId: UnitId;
      owner: PlayerId;
      hex: Hex;
      hpRemaining: number;
    }
  // --- Spotting player only (recon results, spec §11) -----------------------
  /**
   * `owner` is the drone's owner, i.e. the spotting player — the flight and
   * everything it transmits belong to the same side.
   */
  | {
      type: 'DRONE_MOVED';
      unitId: UnitId;
      owner: PlayerId;
      from: Hex;
      to: Hex;
      path: Hex[];
    }
  /**
   * One asset seen inside this round's swath. `kind` is the truth here,
   * including 'decoy'; the visibility filter narrows it to MaskedStaticKind on
   * the way out. Launchers become one-round contacts, static kinds become
   * permanent reveals (spec §11 rule 3).
   *
   * CAREFUL — `owner` here is the owner of the asset that was SPOTTED, which is
   * the enemy of the audience. This is the one owner-only event whose `owner`
   * field is not its recipient: the spotting player is the *other* one. The
   * filter must route this event to `owner`'s opponent, and it is the only
   * event where reading `owner` as "who may see this" is exactly backwards.
   */
  | { type: 'ASSET_SPOTTED'; kind: UnitKind; hex: Hex; owner: PlayerId }
  /**
   * A replacement drone has spawned (spec §11).
   *
   * Owner only: the enemy learning your recon is back online would be free
   * intel they did nothing to earn. The spawn hex is public knowledge (§12);
   * what is private is the timing.
   */
  | { type: 'DRONE_RESPAWNED'; unitId: UnitId; owner: PlayerId; hex: Hex }
  // --- Both players ---------------------------------------------------------
  /**
   * Launches are loud: detection is automatic, universal, and unsuppressable
   * (spec §11). The origin marks an enemy launcher on the defender's map for
   * one round; this log entry is permanent.
   *
   * Carries no launcher id on purpose — the origin hex identifies the firing
   * unit to its owner (nothing else can be standing there), while the enemy
   * gets a place and no trackable identity.
   */
  | { type: 'LAUNCH_DETECTED'; missileId: MissileId; origin: Hex; target: Hex }
  /**
   * A forced march was heard leaving `origin` (spec §9, §11). The second loud
   * action in the game, and detected on exactly the same terms as a launch:
   * automatic, universal, unsuppressable.
   *
   * **Carries the origin and NOT the destination**, which is the entire feature.
   * Publishing where the launcher arrived would hand over its current position —
   * the one thing paying the reveal is supposed to keep. What the enemy gets is
   * a hex the launcher has provably left, plus the public knowledge that it is
   * now within `RULES.forcedMarchMovement` of it.
   *
   * **Emitted in ascending origin-hex order, never in `GameState.units` order**
   * — this is a public event, so units order would publish an ordering of the
   * marching launchers' unit ids and let the enemy track a specific launcher
   * across rounds. That is the cross-round identity §11 keys all intel by hex to
   * withhold, and it is the same reason `canonicalOrder` sorts missiles by origin
   * rather than by the firing launcher's id (§10). The owner-only movement events
   * beside it keep units order, because there is no audience to leak to.
   *
   * `owner` is present even though `LAUNCH_DETECTED` has no such field, and it is
   * not a leak: both recipients can already derive it, since each knows whether
   * the march was one of their own. It saves the client from inferring whose
   * march it was by matching hexes against its own units.
   */
  | { type: 'MARCH_DETECTED'; owner: PlayerId; origin: Hex }
  /**
   * Public, so firing cheap probes to map defense lanes is legitimate strategy
   * (spec §10). Names no interceptor base: the defender knows which of theirs
   * fired, and the attacker learns only that *some* base covers `hex`, i.e. it
   * is one of 7 candidates. Bases are marked on a map only by recon.
   */
  | { type: 'MISSILE_INTERCEPTED'; missileId: MissileId; hex: Hex }
  /**
   * Emitted for EVERY missile that reaches its target hex, including hits on
   * empty ground, and never saying what it hit. Both halves are load-bearing:
   * if IMPACT only fired when something was struck, its mere presence would
   * reveal the hex was occupied and blind-fire probing would find bunkers and
   * bases for free (spec §6).
   */
  | { type: 'IMPACT'; missileId: MissileId; hex: Hex }
  /**
   * Kills are observable. Reports a destroyed decoy TRUTHFULLY as a decoy —
   * masking it would fool nobody, since the absence of dead hand gives it away
   * in the same instant, and a lie the engine has to maintain is a bug waiting
   * to happen (spec §6).
   */
  | { type: 'UNIT_DESTROYED'; unitId: UnitId; kind: UnitKind; hex: Hex }
  /**
   * The owner learns only the death hex, leaving 7 candidates for the killing
   * base. Public because the defender already knows their own base positions,
   * so it leaks nothing to them (spec §6).
   */
  | { type: 'DRONE_DOWNED'; unitId: UnitId; owner: PlayerId; hex: Hex }
  /** `playerId` is the decapitated player — the one who gets the final round. */
  | { type: 'DEAD_HAND_TRIGGERED'; playerId: PlayerId }
  | { type: 'GAME_OVER'; outcome: Outcome };

// ---------------------------------------------------------------------------
// Visibility filter output (spec §6, §11, §12; build-order step 8)
// ---------------------------------------------------------------------------
//
// Everything above this line is the TRUTH — what resolve() computes and what a
// server would hold. Everything below is one player's redacted copy of it, as
// produced by `filterForPlayer` / `filterEventsForPlayer` in ./visibility.
//
// The design rule these types encode: wherever the filter hides something, the
// output type should make the hidden thing *unrepresentable* rather than merely
// absent. A redaction the compiler enforces cannot be undone by a later edit
// that looks reasonable in a diff — and every leak in this game is exactly that
// shape (see the ASSET_SPOTTED note on GameEvent above).

/**
 * One enemy static asset as its finder is told about it.
 *
 * Identical to StaticReveal except that `kind` is MaskedStaticKind, so 'decoy'
 * cannot be expressed here at all (spec §12). The truth lives in StaticReveal
 * on the unfiltered state; this is what leaves the sim.
 */
export interface VisibleStaticReveal {
  hex: Hex;
  kind: MaskedStaticKind;
  /** Round first seen — UI flavour ("spotted round 4"), not a rule. */
  round: number;
}

/**
 * One player's picture of the enemy, redacted.
 *
 * `contacts` passes through unchanged: a LauncherContact is a hex plus how it
 * was spotted, and carries no unit id, no owner and no identity to mask (spec
 * §11 — intel is keyed by place, never by unit).
 */
export interface VisiblePlayerIntel {
  staticReveals: VisibleStaticReveal[];
  contacts: LauncherContact[];
}

/**
 * What one player is allowed to see (spec §6 layer 2). In hotseat this hides
 * the inactive player's information; in V1.5 the server applies it before
 * sending, so a client physically never receives the enemy's positions and
 * cheating is impossible by construction rather than by policy.
 *
 * Three differences from GameState are load-bearing:
 *
 * 1. **`units` holds the viewer's OWN units only.** Enemy assets are not
 *    downgraded into this array — they are absent from it entirely, and the
 *    whole enemy picture lives in `intel`, keyed by hex. That is what makes the
 *    §11 "no trackable identity" rule structural: this type has no field capable
 *    of carrying an enemy UnitId, so no future change can leak one by accident.
 * 2. **`intel` is one player's, not a Record keyed by player.** Handing the
 *    viewer a map slot labelled with the opponent's id is the whole leak.
 * 3. **`droneRespawnIn` is a bare number — the viewer's own.** DRONE_RESPAWNED
 *    is owner-only (spec §6) precisely so the enemy cannot time your recon
 *    coming back online; leaving the opponent's counter in the state would hand
 *    them the same fact directly and make filtering the event pointless.
 *
 * `map` is deliberately the same MapData, unredacted: terrain is public (spec
 * §11) and the board is rotationally symmetric, so there is nothing to hide.
 * `round`, `phase`, `deadHandFor` and `outcome` are public for the same reason
 * their events are — DEAD_HAND_TRIGGERED and GAME_OVER go to both players.
 */
export interface VisibleGameState {
  round: number;
  phase: GamePhase;
  map: MapData;
  units: Unit[];
  intel: VisiblePlayerIntel;
  droneRespawnIn: number;
  deadHandFor: PlayerId | null;
  outcome: Outcome | null;
}

/**
 * What an ASSET_SPOTTED may say a spotted asset is, after masking.
 *
 * Two kinds are missing and both are rules, not oversights: 'decoy' because a
 * spotted decoy is reported as a bunker (spec §12), and 'drone' because no
 * detector in the game ever reveals an enemy drone at all (spec §11 — drones do
 * not reveal each other, and the only thing that touches one is interceptor
 * coverage, which kills it).
 */
export type SpottedKind = 'launcher' | 'bunker' | 'interceptor';

/**
 * One event as a given player receives it (spec §6).
 *
 * Written as an Exclude over GameEvent rather than a parallel union, so a new
 * event kind added above flows through with no second definition to keep in
 * sync — only ASSET_SPOTTED needs restating, because it is the only event whose
 * *content* is masked rather than merely routed.
 *
 * Note this type says nothing about audience: routing is `filterEventsForPlayer`'s
 * job and cannot be expressed in a type, since the same event kind goes to
 * different players depending on its `owner` field.
 */
export type VisibleEvent =
  | Exclude<GameEvent, { type: 'ASSET_SPOTTED' }>
  | { type: 'ASSET_SPOTTED'; kind: SpottedKind; hex: Hex; owner: PlayerId };

/**
 * What `resolve()` hands back (spec §6): the next state, plus the ordered event
 * log for *this* resolution only.
 *
 * The log is deliberately not a field on GameState. Each client appends the
 * events it is allowed to see to its own permanent history (spec §11), so the
 * engine never carries the log from round to round — it would otherwise grow
 * inside the state that gets copied every resolution, and every visibility
 * filter would have to re-filter the entire match's history.
 */
export interface ResolveResult {
  state: GameState;
  events: GameEvent[];
}
