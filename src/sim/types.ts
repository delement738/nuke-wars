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
   * Blind fire is legal (spec §3): the target hex need not contain anything
   * the player can see. It must simply be on the map, within range 6, and not
   * the launcher's own hex.
   */
  | { type: 'LAUNCH'; unitId: UnitId; target: Hex }
  /** Straight-line drone flight, destination within 6 (spec §11). */
  | { type: 'FLY'; unitId: UnitId; destination: Hex };

/** Narrowed to the MOVE variant — the input shape the movement engine takes. */
export type MoveOrder = Extract<Order, { type: 'MOVE' }>;

/** Narrowed to the FLY variant — the input shape the recon engine takes. */
export type FlyOrder = Extract<Order, { type: 'FLY' }>;

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
   * How it was spotted. RECON contacts may already be stale — recon flies in
   * phase 1 and launchers move in phase 5 of the same round. LAUNCH contacts
   * cannot be: a launcher that fired could not also move, and counter-battery
   * missiles land in phase 3, before movement (spec §3, §11).
   */
  source: 'RECON' | 'LAUNCH';
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
 */
export type GameEvent =
  // --- Owner only -----------------------------------------------------------
  | { type: 'UNIT_MOVED'; unitId: UnitId; from: Hex; to: Hex }
  /**
   * A MOVE order that did not happen — the destination was blocked by a unit
   * the player couldn't see, or two units bounced off the same hex (spec §9).
   *
   * Deliberately carries nothing but the mover's own id: no destination, no
   * blocker, no reason code. That makes a standoff byte-identical to being
   * blocked by a stationary enemy, so the player cannot tell whether someone
   * was parked on that hex or raced them to it — two facts with very different
   * tactical meaning. The event is leak-proof by construction rather than by
   * policy: it contains no enemy-derived data for a future change to widen.
   */
  | { type: 'MOVE_FAILED'; unitId: UnitId }
  /**
   * Non-lethal bunker damage — the real bunker taking 1 of its 2 hits.
   *
   * Owner only, and load-bearing: to the attacker this is indistinguishable
   * from hitting empty ground. A decoy never emits it (it dies to that hit),
   * so *silence after a hit* is exactly what identifies the real bunker
   * (spec §6, §12).
   */
  | { type: 'BUNKER_HIT'; unitId: UnitId; hex: Hex; hpRemaining: number }
  // --- Spotting player only (recon results, spec §11) -----------------------
  | { type: 'DRONE_MOVED'; unitId: UnitId; from: Hex; to: Hex; path: Hex[] }
  /**
   * One asset seen inside this round's swath. `kind` is the truth here,
   * including 'decoy'; the visibility filter narrows it to MaskedStaticKind on
   * the way out. Launchers become one-round contacts, static kinds become
   * permanent reveals (spec §11 rule 3).
   */
  | { type: 'ASSET_SPOTTED'; kind: UnitKind; hex: Hex; owner: PlayerId }
  /**
   * A replacement drone has spawned (spec §11).
   *
   * NOTE: not in the spec §6 visibility table — flagged for a spec amendment.
   * Owner only is the obvious audience; the enemy learning your recon is back
   * online would be free intel they did nothing to earn.
   */
  | { type: 'DRONE_RESPAWNED'; unitId: UnitId; hex: Hex }
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
