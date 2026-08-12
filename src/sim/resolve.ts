// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// resolve(): the simulation engine's single entry point (spec §6). It takes the
// full, unfiltered state plus both players' orders and returns the next state
// together with the ordered event log clients animate from. In V1.5 this same
// function runs server-side and authoritative, unchanged.
//
// Build-order step 4 implemented the skeleton and phase 5 (ground movement, §9);
// step 5 added phase 1 (recon flight, §10/§11) and the drone respawn tick; step 6
// added phases 2 and 3 (launch & interception, then impact); step 7 filled in
// phase 4 (the outcome check, §4) and with it the dead-hand round and the rest of
// §5's state machine. All five phases now exist.
//
// The five-phase order from spec §3 produces several deliberate consequences,
// and now that every phase exists they are real rather than planned: strikes land
// before movement, so a launcher that fired last round cannot dodge the
// counter-battery; two launchers that fire at each other both die, with no rule
// needed to say so; recon flies first, so the drone photographs launchers at
// their pre-move positions and its intel can only pay off next round; and phase 4
// sits *above* movement, so the round that decapitates a player is also a round
// in which nobody moves — you cannot reposition out of the dead-hand volley you
// just provoked.
//
// THE STATE MACHINE (spec §5) lives in this file's last two functions. resolve()
// is the single entry point for both kinds of round: a normal one runs phases
// 1–5, and a dead-hand one runs phases 2–3 only (§3) and then ends the match. The
// caller never picks — `state.phase` does, which is what keeps a store or a V1.5
// server from having to know the difference.
//
// DETERMINISM (spec §6): V1 resolution reads no randomness at all. The `_seed`
// parameter exists only so the signature doesn't have to change if V2
// reintroduces chance; the underscore is there to make reading it look as wrong
// as it is. Every remaining nondeterminism risk here is iteration order, which
// is why every place order could leak in — conflict adjudication, event
// emission, and iterating the two players — is pinned below.

import { RULES, SPAWNS, UNIT_DEFS } from './defs';
import { hexKey, offsetToAxial, type Hex } from './hex';
import {
  canonicalOrder,
  createMissile,
  damageByHex,
  flyMissiles,
  validateLaunch,
  type Missile,
} from './missiles';
import { validateMove, type MoveIllegalReason } from './movement';
import { adjudicate, type Adjudication } from './outcomes';
import { flyDrone, reconSwath, validateFly, type DroneFlight } from './recon';
import {
  PLAYERS,
  opponentOf,
  type GameEvent,
  type GameState,
  type LauncherContact,
  type Order,
  type PlayerId,
  type PlayerIntel,
  type ResolveResult,
  type Unit,
  type UnitId,
} from './types';

/**
 * A fresh, structurally-shared-free copy of both players' intel.
 *
 * Every phase that files or removes a sighting takes one of these first, so no
 * phase ever writes into the state it was handed. resolve() is pure — callers
 * keep the previous state as history (spec §6).
 */
function copyIntel(intel: Record<PlayerId, PlayerIntel>): Record<PlayerId, PlayerIntel> {
  return {
    p1: { staticReveals: [...intel.p1.staticReveals], contacts: [...intel.p1.contacts] },
    p2: { staticReveals: [...intel.p2.staticReveals], contacts: [...intel.p2.contacts] },
  };
}

/**
 * File a launcher sighting, from either detector (spec §11).
 *
 * Keyed by hex, so the same launcher seen twice in one round is recorded once —
 * and the FIRST source to see it is the one kept. That matters only for UI
 * flavour: a launcher that fired cannot also have moved (`RULES.ordersPerUnit`),
 * so when recon and launch detection both report the same hex they agree, and a
 * RECON contact that would normally be "possibly stale" happens to be live.
 */
function recordContact(
  intel: PlayerIntel,
  hex: Hex,
  source: LauncherContact['source'],
): void {
  if (intel.contacts.some((c) => hexKey(c.hex) === hexKey(hex))) return;
  intel.contacts.push({ hex, source });
}

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
      recordContact(intel, spotted.position, 'RECON');
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
      owner: drone.owner,
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
    events.push({
      type: 'DRONE_RESPAWNED',
      unitId: unit.id,
      owner: unit.owner,
      hex,
    });
  }

  return { units, droneRespawnIn, events };
}

// ---------------------------------------------------------------------------
// Phase 2 — launch & interception (spec §3, §10, §11)
// ---------------------------------------------------------------------------

/**
 * Resolution phase 2 — every missile fires and flies at once, and interceptor
 * bases engage what they can reach (spec §10).
 *
 * Two things happen here that are easy to read past. First, **every launch is
 * detected, by both players, always** — launches are loud, detection needs no
 * equipment and nothing suppresses it (§11), so the origin hex goes onto the
 * defender's map as a launcher contact whether or not the missile survives.
 * Second, a rejected LAUNCH is dropped in **silence**: like a FLY and unlike a
 * MOVE, every way it can fail is derivable from what the ordering player already
 * knows, so there is nothing hidden information could have caused and nothing to
 * report (§9's policy, applied to the missile layer).
 *
 * The contact is filed against `opponentOf(owner)` because intel is keyed by the
 * *viewer*: `intel.p1` is what p1 knows about p2, so p1's launch marks p2's map.
 */
function runLaunchPhase(
  state: GameState,
  orders: OrderBook,
): {
  intel: Record<PlayerId, PlayerIntel>;
  survivors: Missile[];
  events: GameEvent[];
} {
  const unitsById = new Map(state.units.map((unit) => [unit.id, unit]));
  const fired: Missile[] = [];

  for (const player of PLAYERS) {
    for (const order of orders[player].values()) {
      // MOVE belongs to phase 5 and FLY was consumed by phase 1. Both are
      // counted by ordersByUnit, so move-XOR-launch is already enforced by the
      // budget — a launcher handed a MOVE *and* a LAUNCH reached neither phase.
      if (order.type !== 'LAUNCH') continue;
      if (!validateLaunch(state, player, order).legal) continue;

      const launcher = unitsById.get(order.unitId);
      // Unreachable: a legal verdict already proves the unit exists, is this
      // player's, and is a living launcher.
      if (!launcher) continue;

      fired.push(createMissile(state.round, launcher, order.target));
    }
  }

  // Canonical order is by origin hex, never by the order either client listed
  // its launches and never by launcher id (see `canonicalOrder` in missiles.ts).
  // Adjudication and emission share it, so the log is byte-identical for the
  // same physical round no matter how a client sorted its submission (§6).
  const missiles = canonicalOrder(fired);
  const intel = copyIntel(state.intel);
  const events: GameEvent[] = [];

  for (const missile of missiles) {
    events.push({
      type: 'LAUNCH_DETECTED',
      missileId: missile.id,
      origin: missile.origin,
      target: missile.target,
    });
    recordContact(intel[opponentOf(missile.owner)], missile.origin, 'LAUNCH');
  }

  // Emitted after every LAUNCH_DETECTED because that is the order it happened
  // in: the whole volley leaves the ground, then the defenses engage it.
  // Interceptions are already chronological within themselves (by flight step).
  const flights = flyMissiles(state.units, missiles);
  for (const { missile, hex } of flights.interceptions) {
    events.push({ type: 'MISSILE_INTERCEPTED', missileId: missile.id, hex });
  }

  return { intel, survivors: flights.survivors, events };
}

// ---------------------------------------------------------------------------
// Phase 3 — impact (spec §3, §6, §12)
// ---------------------------------------------------------------------------

/**
 * Drop a publicly destroyed asset from the enemy's map (spec §11).
 *
 * A static sighting is permanent "until the asset is publicly destroyed", and
 * `UNIT_DESTROYED` is exactly that public moment — so the marker goes with it.
 * A launcher contact is cleared for the same reason even though it would expire
 * next round anyway: the map is supposed to show only things that are true right
 * now, and both players just watched this one die.
 *
 * Keyed by hex, like everything else in intel — a ground hex holds at most one
 * unit (§9), so the hex identifies the entry without a unit id ever entering the
 * intel state.
 */
function forgetDestroyed(intel: PlayerIntel, unit: Unit): void {
  const key = hexKey(unit.position);
  intel.staticReveals = intel.staticReveals.filter((r) => hexKey(r.hex) !== key);
  intel.contacts = intel.contacts.filter((c) => hexKey(c.hex) !== key);
}

/**
 * Resolution phase 3 — surviving missiles land simultaneously (spec §3).
 *
 * Damage is totalled **per hex** before anything is applied, because hits stack
 * within a round: two missiles on one full-health bunker deal 2 and destroy it
 * outright. Applying one hit per hex instead would make the 2-missile alpha
 * strike — a deliberate, expensive way to skip the decoy test (§12) —
 * impossible.
 *
 * Whatever stands on the hex takes it, friendly or enemy: a missile is aimed at
 * ground, not at a target. Drones are the one exception, and it is not a special
 * case so much as the air layer: missiles cannot touch them at all (§2).
 *
 * Event order: every `IMPACT` first, in canonical missile order, then the damage
 * events in `GameState.units` order (§9's canonical emission rule). Keeping them
 * in separate passes is also what keeps `IMPACT` honest — it fires for **every**
 * arriving missile including hits on bare ground, and never names a victim,
 * because if its presence implied occupancy then blind-fire probing would locate
 * bunkers and bases for free (§6).
 */
function runImpactPhase(
  state: GameState,
  survivors: readonly Missile[],
): {
  units: Unit[];
  intel: Record<PlayerId, PlayerIntel>;
  events: GameEvent[];
} {
  if (survivors.length === 0) {
    return { units: state.units, intel: state.intel, events: [] };
  }

  const events: GameEvent[] = survivors.map((missile) => ({
    type: 'IMPACT',
    missileId: missile.id,
    hex: missile.target,
  }));

  const damage = damageByHex(survivors);
  const intel = copyIntel(state.intel);
  const units: Unit[] = [];

  for (const unit of state.units) {
    const hits = damage.get(hexKey(unit.position)) ?? 0;
    if (hits === 0 || unit.destroyed || unit.kind === 'drone') {
      units.push(unit);
      continue;
    }

    const hp = unit.hp - hits;

    if (hp > 0) {
      units.push({ ...unit, hp });
      // A survivable hit is reported only for the two site kinds, and only to
      // their owner. To the attacker it is indistinguishable from hitting empty
      // ground, which is what protects "only drones find bunkers" from
      // blind-fire probing (§6).
      //
      // The decoy is named here deliberately, though at 1 HP it can never reach
      // this branch — it always dies to the hit, and that silence-versus-
      // destruction difference IS the tell that identifies the real bunker
      // (§12). Writing the rule as "bunker or decoy" means §12's tuning lever
      // (raise the decoy to 2 HP) stays indistinguishable by construction
      // instead of needing a new rule. The event is owner-only, so it leaks
      // nothing either way.
      if (unit.kind === 'bunker' || unit.kind === 'decoy') {
        events.push({
          type: 'BUNKER_HIT',
          unitId: unit.id,
          owner: unit.owner,
          hex: unit.position,
          hpRemaining: hp,
        });
      }
      continue;
    }

    units.push({ ...unit, hp: 0, destroyed: true });
    // Public, and TRUTHFUL about a decoy (§6): masking it would fool nobody,
    // since the absence of dead hand gives it away in the same instant, and a
    // lie the engine has to maintain is a bug waiting to happen.
    events.push({
      type: 'UNIT_DESTROYED',
      unitId: unit.id,
      kind: unit.kind,
      hex: unit.position,
    });
    forgetDestroyed(intel[opponentOf(unit.owner)], unit);
  }

  return { units, intel, events };
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
      events.push({
        type: 'UNIT_MOVED',
        unitId: unit.id,
        owner: unit.owner,
        from: unit.position,
        to,
      });
      continue;
    }

    units.push(unit);
    if (failed.has(unit.id)) {
      events.push({ type: 'MOVE_FAILED', unitId: unit.id, owner: unit.owner });
    }
  }

  return { units, events };
}

// ---------------------------------------------------------------------------
// Phase 4 — outcome check, and spec §5's state machine
// ---------------------------------------------------------------------------

/**
 * End the round on phase 4's verdict (spec §3, §4, §5).
 *
 * Reaching here means the round stops at phase 4: **ground movement and the
 * drone respawn tick are both skipped.** §3 says that of dead hand; step 7
 * generalised it to any verdict, because movement cannot change a single §4
 * condition (nothing about moving destroys anything) so the outcome is identical
 * either way — and a log that shows launchers driving around *after* GAME_OVER
 * would have a client animating a match that had already finished. The respawn
 * tick goes with it for the reason it exists at all: it belongs to the start of
 * the next *order* phase (§11), and there isn't one. A dead-hand round has no
 * flight phase to use a drone in, and a finished match has no next round.
 *
 * The round number moves differently in the two cases, and both are deliberate:
 *
 * - **Dead hand increments it.** The final round is a real round, and missile
 *   ids are `r{round}@{origin}` (§6) — reusing the number would let a launcher
 *   that fires twice from the same hex produce two events with one id in a log
 *   that keeps both forever.
 * - **Game over freezes it.** `round` means "the round being played", and once
 *   the match is over none is; the number is left reading as the last round that
 *   actually happened.
 */
function endRound(
  working: GameState,
  events: GameEvent[],
  verdict: Exclude<Adjudication, { type: 'CONTINUE' }>,
): ResolveResult {
  if (verdict.type === 'DEAD_HAND') {
    // Public (§6): both players watch the bunker die, and the retaliation round
    // is not a surprise — the attacker's whole plan was to survive it.
    events.push({ type: 'DEAD_HAND_TRIGGERED', playerId: verdict.player });
    return {
      state: {
        ...working,
        round: working.round + 1,
        phase: 'DEAD_HAND_PHASE',
        deadHandFor: verdict.player,
      },
      events,
    };
  }

  events.push({ type: 'GAME_OVER', outcome: verdict.outcome });
  return {
    state: { ...working, phase: 'GAME_OVER', outcome: verdict.outcome },
    events,
  };
}

/**
 * The dead-hand round (spec §3): the decapitated player's final volley.
 *
 * **Launches only** — phases 2 and 3, then adjudication. There is no recon
 * phase, no ground movement, and no respawn tick, which is exactly why step 6
 * built `runLaunchPhase` and `runImpactPhase` to take a state and hand back a
 * result: this function calls the pair directly instead of re-entering a round.
 *
 * The opponent issues no orders at all. That is expressed by handing the launch
 * phase an **empty order book** for them rather than by teaching the phase about
 * dead hand — an order they never submitted and an order that was discarded look
 * identical from inside phase 2, and only one of those needs a branch. Their
 * interceptor bases still defend normally: `flyMissiles` reads bases off the
 * board, not off an order.
 *
 * Launcher contacts are deliberately NOT rebuilt here. A contact filed during
 * round N's resolution is live for round N+1's order phase (§11), and for a
 * decapitated player that order phase *is* the dead-hand phase — those sightings
 * are precisely the intel they are entitled to aim their last shots with.
 */
function resolveDeadHand(
  state: GameState,
  ordersP1: readonly Order[],
  ordersP2: readonly Order[],
): ResolveResult {
  const player = state.deadHandFor;
  if (!player) {
    throw new Error('resolve(): DEAD_HAND_PHASE with no deadHandFor set');
  }

  const empty: ReadonlyMap<UnitId, Order> = new Map();
  const submitted = player === 'p1' ? ordersP1 : ordersP2;
  const orders: OrderBook = {
    p1: player === 'p1' ? ordersByUnit(submitted) : empty,
    p2: player === 'p2' ? ordersByUnit(submitted) : empty,
  };

  const events: GameEvent[] = [];
  let working: GameState = state;

  // --- Phase 2: launch & interception (spec §10) -------------------------------
  const launches = runLaunchPhase(working, orders);
  working = { ...working, intel: launches.intel };
  events.push(...launches.events);

  // --- Phase 3: impact (spec §3) -----------------------------------------------
  const impacts = runImpactPhase(working, launches.survivors);
  working = { ...working, units: impacts.units, intel: impacts.intel };
  events.push(...impacts.events);

  // --- Adjudication (spec §4) --------------------------------------------------
  // Always terminal: this round only exists because a real bunker was destroyed,
  // so `adjudicate` sees at least one and returns MUTUAL_ANNIHILATION (the
  // retaliation answered in kind) or DECAPITATION (it did not). Anything else
  // means the state machine was driven into this phase by hand.
  const verdict = adjudicate(working);
  if (verdict.type !== 'OUTCOME') {
    throw new Error('resolve(): dead-hand round with no decapitation to settle');
  }

  return endRound(working, events, verdict);
}

/**
 * Advance the game by one round — the engine's single entry point (spec §6).
 *
 * Pure: the input state is never mutated. Units that move are rebuilt as new
 * objects and everything else is shared by reference, so callers may keep the
 * previous state as history.
 *
 * `state.phase` selects the round type, so no caller has to know the difference
 * between a normal round and a dead-hand one (spec §5). Two of the five values in
 * `GamePhase` are never resting states: resolution is atomic here, so a state
 * handed back by this function is never mid-`RESOLUTION` — that value and the
 * diagram's `FINAL_RESOLUTION` exist for the presentation layer to sit in while
 * it animates the log.
 *
 * Throws when called on a match that has finished or has not begun. Both are
 * caller bugs rather than bad input — the phase is the engine's own to set, not
 * a client's — and the alternative is a silent no-op that hides the bug (same
 * reasoning as `generateMap` throwing rather than shipping a bad map, §7).
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
  if (state.phase === 'GAME_OVER') {
    throw new Error('resolve(): the match is already over');
  }
  if (state.phase === 'SETUP') {
    throw new Error('resolve(): placement is not finished — call startMatch()');
  }
  if (state.phase === 'DEAD_HAND_PHASE') {
    return resolveDeadHand(state, ordersP1, ordersP2);
  }

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

  // --- Phase 2: launch & interception (spec §10, §11) --------------------------
  // Files LAUNCH-sourced launcher contacts on top of the recon contacts phase 1
  // just rebuilt, so a launcher that both fired and was photographed is one
  // hex-keyed entry, not two (spec §11).
  const launches = runLaunchPhase(working, orders);
  working = { ...working, intel: launches.intel };
  events.push(...launches.events);

  // --- Phase 3: impact (spec §3, §12) ------------------------------------------
  // Runs against the board phase 2 left, and hands phase 5 a post-impact one —
  // §9's "movement is applied against the post-impact state" is true by
  // construction here, not a rule anyone has to remember.
  const impacts = runImpactPhase(working, launches.survivors);
  working = { ...working, units: impacts.units, intel: impacts.intel };
  events.push(...impacts.events);

  // --- Phase 4: outcome check (spec §3, §4, §5) --------------------------------
  // Read off the post-impact board, which is the only place in a round where
  // anything is destroyed — so this is "after a full resolution" in the sense §5
  // means it, even though phase 5 has yet to run. A verdict here ends the round
  // where it stands: see `endRound` for why movement and the respawn tick are
  // both skipped rather than run for a match that has just finished.
  const verdict = adjudicate(working);
  if (verdict.type !== 'CONTINUE') return endRound(working, events, verdict);

  // --- Phase 5: ground movement (spec §9) --------------------------------------
  const movement = runGroundMovement(working, orders);
  working = { ...working, units: movement.units };
  events.push(...movement.events);

  // --- Entering the next order phase: drone respawn tick (spec §11) ------------
  // Not a resolution phase — see runDroneRespawns. It is reached only when the
  // match continues, because it belongs to the start of the next order phase and
  // a round that ended at phase 4 has none (see `endRound`).
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
