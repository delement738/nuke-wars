// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// resolve(): the simulation engine's single entry point (spec §6). It takes the
// full, unfiltered state plus both players' orders and returns the next state
// together with the ordered event log clients animate from. In V1.5 this same
// function runs server-side and authoritative, unchanged.
//
// Build-order step 4 implemented the skeleton and phase 5 (ground movement, §9);
// step 5 added phase 1 (recon flight, §10/§11) and the drone respawn tick.
// Phases 2–4 are stubs that name the step which fills each one. The five-phase
// order from spec §3 is already laid out below, because that order produces
// several deliberate consequences (strikes land before movement, so a launcher
// that fired cannot dodge the counter-battery; recon flies first, so the drone
// photographs launchers at their pre-move positions) — getting it in place early
// means later steps drop into a slot rather than re-sequencing the round.
//
// DETERMINISM (spec §6): V1 resolution reads no randomness at all. The `_seed`
// parameter exists only so the signature doesn't have to change if V2
// reintroduces chance; the underscore is there to make reading it look as wrong
// as it is. Every remaining nondeterminism risk here is iteration order, which
// is why every place order could leak in — conflict adjudication, event
// emission, and iterating the two players — is pinned below.

import { RULES, SPAWNS, UNIT_DEFS } from './defs';
import { hexKey, offsetToAxial, type Hex } from './hex';
import { validateMove, type MoveIllegalReason } from './movement';
import { flyDrone, reconSwath, validateFly, type DroneFlight } from './recon';
import type {
  GameEvent,
  GameState,
  Order,
  PlayerId,
  PlayerIntel,
  ResolveResult,
  Unit,
  UnitId,
} from './types';

/**
 * Canonical player iteration order. Nothing in V1 resolution is order-dependent
 * between the two players — drones never interact and movement is adjudicated
 * globally — but pinning the order keeps the event log byte-identical anyway,
 * which is what the §6 determinism test actually asserts.
 */
const PLAYERS: readonly PlayerId[] = ['p1', 'p2'];

/** One player's surviving orders for the round, keyed by the unit they name. */
type OrderBook = Record<PlayerId, ReadonlyMap<UnitId, Order>>;

// ---------------------------------------------------------------------------
// Phase 1 — recon flight (spec §3, §10, §11)
// ---------------------------------------------------------------------------

/**
 * File one spotted enemy asset into the spotting player's intel (spec §11).
 *
 * The two piles have different lifetimes because mobility is the only thing
 * that decides how long a sighting stays true: a launcher moves 3 hexes a round
 * so its contact is good for one order phase, while a bunker, decoy or base
 * cannot move at all, so the sighting stays true until it is publicly
 * destroyed.
 *
 * `kind` is stored as the TRUTH, decoys included. resolve() never lies; the
 * decoy -> bunker mask belongs to the visibility filter alone (spec §6, §12,
 * build-order step 8).
 *
 * Both piles are keyed by hex, so seeing the same asset twice in one swath —
 * easily done, since neighbouring path hexes share corridor hexes — records it
 * once. A static asset already on file keeps its original `round`: that field
 * means "first spotted", and re-photographing a building that cannot move is
 * not news.
 */
function recordSighting(intel: PlayerIntel, spotted: Unit, round: number): void {
  const key = hexKey(spotted.position);

  switch (spotted.kind) {
    case 'launcher':
      if (!intel.contacts.some((c) => hexKey(c.hex) === key)) {
        // Step 6 adds LAUNCH-sourced contacts in phase 2. A launcher that fired
        // cannot also have moved, so if recon saw it too both agree on the hex;
        // whichever lands first is the one kept.
        intel.contacts.push({ hex: spotted.position, source: 'RECON' });
      }
      return;

    case 'drone':
      // Unreachable: callers skip enemy drones before getting here. Drones are
      // never detectable by anything (spec §2, §11) — they do not even reveal
      // each other — so there is no pile for one to go in.
      return;

    default:
      if (!intel.staticReveals.some((r) => hexKey(r.hex) === key)) {
        intel.staticReveals.push({
          hex: spotted.position,
          kind: spotted.kind,
          round,
        });
      }
  }
}

/**
 * Resolution phase 1 — drones fly, get shot at, and photograph what survives
 * the trip (spec §3, §10, §11).
 *
 * Runs first, which is why the swath sees launchers at their *pre-move*
 * positions and why drone intel can never influence a launch committed the same
 * round — it pays off next round (spec §3).
 *
 * Both drones fly simultaneously and genuinely cannot interact: they do not
 * block each other, reveal each other, or compete for anything (interceptor
 * drone-kills are free and uncapped, spec §10), so every flight is resolved
 * against the same start-of-phase board and the loop order affects only the
 * order of the log, which is pinned to `GameState.units` like every other
 * emission (spec §9).
 *
 * A drone with no order — or with one that failed validation, or that went over
 * budget — **hovers, and a hovering drone still watches**: its flight is
 * resolved as a zero-length line, so it transmits the swath around its own hex.
 * That is what makes "give no order to hover" (spec §11) a real choice; a
 * hovering drone simply trades the width of a sweep for the certainty of not
 * flying into a coverage bubble.
 */
function runReconPhase(
  state: GameState,
  orders: OrderBook,
): {
  units: Unit[];
  intel: Record<PlayerId, PlayerIntel>;
  downed: PlayerId[];
  events: GameEvent[];
} {
  // Launcher contacts are rebuilt from scratch every resolution rather than
  // expired by bookkeeping (spec §11). Static reveals are carried over, because
  // they are permanent — they leave the map only when the asset is publicly
  // destroyed, which is build-order step 6's job.
  const intel: Record<PlayerId, PlayerIntel> = {
    p1: { staticReveals: [...state.intel.p1.staticReveals], contacts: [] },
    p2: { staticReveals: [...state.intel.p2.staticReveals], contacts: [] },
  };

  const events: GameEvent[] = [];
  const flights = new Map<UnitId, DroneFlight>();
  const downed: PlayerId[] = [];

  for (const drone of state.units) {
    if (drone.kind !== 'drone' || drone.destroyed) continue;

    const order = orders[drone.owner].get(drone.id);
    const destination =
      order?.type === 'FLY' && validateFly(state, drone.owner, order).legal
        ? order.destination
        : drone.position; // hover — see the note above

    const flight = flyDrone(state.units, drone, destination);
    flights.set(drone.id, flight);

    // `to` and `path` describe what the drone TRANSMITTED, so on a downed
    // flight they stop one hex short of where it died: a drone that is shot
    // down reveals nothing from its death hex (spec §11). Anything building the
    // reveal overlay from `path` is therefore correct without knowing that
    // rule. The death hex arrives separately, in DRONE_DOWNED.
    events.push({
      type: 'DRONE_MOVED',
      unitId: drone.id,
      from: drone.position,
      to: flight.path[flight.path.length - 1],
      path: flight.path,
    });

    // Iterating units (not swath hexes) does three jobs at once: emission order
    // is canonical, each spotted asset yields exactly one event however many
    // times the corridor covered it, and the drone's own side is skipped
    // wholesale — your own assets are always visible, so they are not intel.
    const swath = reconSwath(flight.path);
    for (const spotted of state.units) {
      if (spotted.owner === drone.owner || spotted.destroyed) continue;
      if (spotted.kind === 'drone') continue; // never detectable (§2, §11)
      if (!swath.has(hexKey(spotted.position))) continue;

      events.push({
        type: 'ASSET_SPOTTED',
        kind: spotted.kind,
        hex: spotted.position,
        owner: spotted.owner,
      });
      recordSighting(intel[drone.owner], spotted, state.round);
    }

    // Emitted last because it happened last: everything above was transmitted
    // before the drone entered the hex that killed it.
    if (flight.downedAt) {
      events.push({
        type: 'DRONE_DOWNED',
        unitId: drone.id,
        owner: drone.owner,
        hex: flight.downedAt,
      });
      downed.push(drone.owner);
    }
  }

  // A downed drone keeps its unit and its id, flagged destroyed, sitting on the
  // hex it died over — the respawn revives this same unit (see the note on
  // droneFor in recon.ts). Its position is the death hex, not the last hex it
  // transmitted from: the wreck is where the interceptor caught it.
  const units = state.units.map((unit) => {
    const flight = flights.get(unit.id);
    if (!flight) return unit;
    if (flight.downedAt) {
      return { ...unit, position: flight.downedAt, hp: 0, destroyed: true };
    }
    const to = flight.path[flight.path.length - 1];
    return hexKey(to) === hexKey(unit.position) ? unit : { ...unit, position: to };
  });

  return { units, intel, downed, events };
}

/**
 * The drone respawn tick (spec §11) — not one of §3's five resolution phases.
 * It belongs to the *start of the next order phase*, which is exactly what the
 * end of a resolution is, so it runs last and its effect is visible to the
 * player when they next give orders.
 *
 * That placement is what produces "one full blind round". A drone downed during
 * round N's phase 1 sets the counter to `RULES.droneRespawnDelay` (2); the tick
 * at the end of that same resolution takes it to 1, so round N+1's order phase
 * has no drone; the tick at the end of round N+1 takes it to 0 and revives the
 * unit, so the drone is on the board and orderable for round N+2. Recon can be
 * taxed and delayed, never permanently denied.
 *
 * `DRONE_RESPAWNED` is owner-only (spec §6): the spawn hex is public knowledge,
 * but the *timing* of your recon coming back online is not the enemy's to have.
 */
function runDroneRespawns(state: GameState): {
  units: Unit[];
  droneRespawnIn: Record<PlayerId, number>;
  events: GameEvent[];
} {
  const droneRespawnIn = { ...state.droneRespawnIn };
  const due = new Set<PlayerId>();

  for (const player of PLAYERS) {
    if (droneRespawnIn[player] <= 0) continue;
    droneRespawnIn[player] -= 1;
    if (droneRespawnIn[player] === 0) due.add(player);
  }

  if (due.size === 0) {
    return { units: state.units, droneRespawnIn, events: [] };
  }

  const units: Unit[] = [];
  const events: GameEvent[] = [];

  for (const unit of state.units) {
    if (unit.kind !== 'drone' || !unit.destroyed || !due.has(unit.owner)) {
      units.push(unit);
      continue;
    }

    const hex = offsetToAxial(SPAWNS[unit.owner].drone);
    units.push({
      ...unit,
      position: hex,
      hp: UNIT_DEFS.drone.hp,
      destroyed: false,
    });
    events.push({ type: 'DRONE_RESPAWNED', unitId: unit.id, hex });
  }

  return { units, droneRespawnIn, events };
}

// ---------------------------------------------------------------------------
// Phase 5 — ground movement (spec §3, §9)
// ---------------------------------------------------------------------------

/**
 * The only rejection reasons that earn a `MOVE_FAILED` event (spec §9).
 *
 * These two are exactly the failures *hidden information* can cause: the
 * destination held an enemy the player could not see, or an unseen enemy
 * blocked every route to it. Reporting them is the intentional information leak
 * §9 describes — making contact is real intelligence, and the defender's reward
 * for positioning well.
 *
 * Every other reason is a fact the ordering player could already see. Terrain
 * is public (§11), a unit's own position and kind are its own, and the UI
 * validates against the filtered state before submitting — so an order failing
 * for any of those is a client bug, not gameplay, and it is dropped silently.
 * Emitting `MOVE_FAILED` for those would make "your advance met resistance"
 * ambiguous, and for an order naming an *enemy* unit it would be an outright
 * leak: the event would put a real enemy unit id into the sender's log, which
 * §11 withholds by design.
 */
const CONTACT_REASONS: ReadonlySet<MoveIllegalReason> = new Set([
  'TILE_OCCUPIED',
  'OUT_OF_RANGE',
]);

/**
 * A MOVE order that named a living, orderable unit owned by the ordering player
 * and passed `validateMove` against the start-of-phase snapshot.
 *
 * Still provisional — a destination two or more units claim becomes a standoff
 * and none of them move (spec §9).
 */
interface AdmittedMove {
  unit: Unit;
  destination: Hex;
}

/** Units whose MOVE order produced no movement — one `MOVE_FAILED` each. */
type FailedMovers = Set<UnitId>;

interface MovementOutcome {
  /** New position per unit that actually moved. */
  moved: Map<UnitId, Hex>;
  failed: FailedMovers;
}

/**
 * One player's orders keyed by the unit they name, with over-budget units
 * dropped entirely (`RULES.ordersPerUnit`, spec §3/§9).
 *
 * Counts EVERY order kind, not just MOVEs. That is what makes move-XOR-launch
 * structural: a launcher handed both a MOVE and a LAUNCH has two orders, is
 * over budget, and does nothing at all. Counting only MOVEs would quietly let
 * that pair through the moment step 6 implements launches.
 *
 * A unit over budget holds position and emits nothing. The engine deliberately
 * does not guess which of the conflicting orders was meant — silently honouring
 * the first would make the outcome depend on the client's array order, and an
 * honest UI can never produce this case anyway.
 *
 * Called ONCE per player at the top of resolve() and shared by every phase, so
 * the budget verdict cannot differ between phases. A drone handed both a MOVE
 * and a FLY must be over budget in the recon phase for the same reason it is in
 * the movement phase.
 */
function ordersByUnit(orders: readonly Order[]): Map<UnitId, Order> {
  const counts = new Map<UnitId, number>();
  for (const order of orders) {
    counts.set(order.unitId, (counts.get(order.unitId) ?? 0) + 1);
  }

  const kept = new Map<UnitId, Order>();
  for (const order of orders) {
    if ((counts.get(order.unitId) ?? 0) > RULES.ordersPerUnit) continue;
    kept.set(order.unitId, order);
  }
  return kept;
}

/**
 * Validate one player's MOVE orders against the start-of-phase board.
 *
 * `state` here is the snapshot every move is judged against — spec §9's
 * foundational rule. No move may see another move's result, which is what keeps
 * resolution order-independent and therefore deterministic (§6).
 */
function admitMoves(
  state: GameState,
  unitsById: ReadonlyMap<UnitId, Unit>,
  playerId: PlayerId,
  orders: ReadonlyMap<UnitId, Order>,
): { admitted: AdmittedMove[]; failed: UnitId[] } {
  const admitted: AdmittedMove[] = [];
  const failed: UnitId[] = [];

  for (const order of orders.values()) {
    // FLY was consumed by phase 1; LAUNCH is build-order step 6. Both are
    // counted by ordersByUnit (so the one-order-per-unit rule is already
    // correct) but neither is acted on here.
    if (order.type !== 'MOVE') continue;

    const check = validateMove(state, playerId, order);
    if (!check.legal) {
      if (CONTACT_REASONS.has(check.reason)) failed.push(order.unitId);
      continue;
    }

    const unit = unitsById.get(order.unitId);
    // Unreachable: a legal verdict already proves the unit exists and is this
    // player's. Narrowing rather than asserting keeps the impossible case from
    // becoming a crash if validateMove's contract ever changes.
    if (!unit) continue;

    admitted.push({ unit, destination: order.destination });
  }

  return { admitted, failed };
}

/**
 * Cancel every move into a hex two or more units claim (spec §9).
 *
 * Symmetric, so it needs no tiebreak — that is the whole point of the standoff
 * ruling, and the same solution Diplomacy has used for a century. Spans both
 * players, since a contested hex is usually contested by opposing units.
 *
 * Three of §9's five rulings need no code at all and are handled upstream by
 * `validateMove`, because it tests occupancy against this same start-of-phase
 * snapshot: a swap sees both destinations occupied, following a unit into the
 * hex it is vacating sees it still occupied, and an advance into an unseen
 * enemy reports TILE_OCCUPIED. Only the standoff is genuinely new logic.
 */
function settleStandoffs(admitted: readonly AdmittedMove[]): MovementOutcome {
  const claims = new Map<string, number>();
  for (const move of admitted) {
    const key = hexKey(move.destination);
    claims.set(key, (claims.get(key) ?? 0) + 1);
  }

  const moved = new Map<UnitId, Hex>();
  const failed: FailedMovers = new Set();
  for (const move of admitted) {
    if ((claims.get(hexKey(move.destination)) ?? 0) > 1) {
      failed.add(move.unit.id);
    } else {
      moved.set(move.unit.id, move.destination);
    }
  }

  return { moved, failed };
}

/**
 * Resolution phase 5 — ground movement (spec §3, §9). Launchers only; the drone
 * moves by FLY along a `hexLine` and is never fed to ground movement (§11).
 *
 * Returns the new unit array and this phase's events rather than a whole state,
 * so the phase stays a pure function of the board it was handed.
 */
function runGroundMovement(
  state: GameState,
  orders: OrderBook,
): { units: Unit[]; events: GameEvent[] } {
  const unitsById = new Map(state.units.map((unit) => [unit.id, unit]));

  const p1 = admitMoves(state, unitsById, 'p1', orders.p1);
  const p2 = admitMoves(state, unitsById, 'p2', orders.p2);

  const settled = settleStandoffs([...p1.admitted, ...p2.admitted]);
  const failed: FailedMovers = new Set([
    ...p1.failed,
    ...p2.failed,
    ...settled.failed,
  ]);

  // Emission order is pinned to `state.units`, NOT to the order arrays. Both
  // are deterministic, but this one is canonical: the same physical outcome
  // produces the same log no matter how either client happened to sort its
  // submission, so a replay can't diverge over presentation order (spec §6).
  const units: Unit[] = [];
  const events: GameEvent[] = [];

  for (const unit of state.units) {
    const to = settled.moved.get(unit.id);
    if (to) {
      units.push({ ...unit, position: to });
      events.push({ type: 'UNIT_MOVED', unitId: unit.id, from: unit.position, to });
      continue;
    }

    units.push(unit);
    if (failed.has(unit.id)) events.push({ type: 'MOVE_FAILED', unitId: unit.id });
  }

  return { units, events };
}

/**
 * Advance the game by one full round (spec §3, §6).
 *
 * Pure: the input state is never mutated. Units that move are rebuilt as new
 * objects and everything else is shared by reference, so callers may keep the
 * previous state as history.
 *
 * @param _seed Never read in V1 — see the determinism note at the top of this
 * file. Do not plumb an RNG in here.
 */
export function resolve(
  state: GameState,
  ordersP1: readonly Order[],
  ordersP2: readonly Order[],
  _seed: number,
): ResolveResult {
  const events: GameEvent[] = [];

  // Budgets are applied once, up front, so every phase agrees about which
  // orders survived (`RULES.ordersPerUnit`, spec §9). A drone handed both a FLY
  // and a MOVE is over budget in phase 1 for the same reason it is in phase 5.
  const orders: OrderBook = {
    p1: ordersByUnit(ordersP1),
    p2: ordersByUnit(ordersP2),
  };

  // The five phases of spec §3 run in strict order, each one rebinding
  // `working` so the next always sees the board as the previous left it. That
  // is what will make §9's "movement is applied against the post-impact state"
  // true by construction once phase 3 exists, rather than a rule to remember.
  let working: GameState = state;

  // --- Phase 1: recon flight (spec §10, §11) -----------------------------------
  const recon = runReconPhase(working, orders);
  const droneRespawnIn = { ...working.droneRespawnIn };
  for (const player of recon.downed) {
    droneRespawnIn[player] = RULES.droneRespawnDelay;
  }
  working = {
    ...working,
    units: recon.units,
    intel: recon.intel,
    droneRespawnIn,
  };
  events.push(...recon.events);

  // --- Phase 2: launch & interception ---------------------- build-order step 6
  // Phase 2 also files LAUNCH-sourced launcher contacts into `working.intel`,
  // on top of the recon contacts phase 1 just rebuilt (spec §11).
  // --- Phase 3: impact ------------------------------------- build-order step 6
  // --- Phase 4: outcome check ------------------------------ build-order step 7
  // Outcomes are evaluated only after a full resolution, never mid-round
  // (spec §5), and a destroyed real bunker skips phase 5 entirely (§3).

  // --- Phase 5: ground movement (spec §9) --------------------------------------
  const movement = runGroundMovement(working, orders);
  working = { ...working, units: movement.units };
  events.push(...movement.events);

  // --- Entering the next order phase: drone respawn tick (spec §11) ------------
  // Not a resolution phase — see runDroneRespawns. Step 7 should decide whether
  // this runs at all once the game is over or during a dead-hand round, which
  // has no recon phase to lose a drone in anyway (spec §3).
  const respawns = runDroneRespawns(working);
  working = {
    ...working,
    units: respawns.units,
    droneRespawnIn: respawns.droneRespawnIn,
  };
  events.push(...respawns.events);

  return {
    state: {
      ...working,
      round: working.round + 1,
      phase: 'ORDER_PHASE',
    },
    events,
  };
}
