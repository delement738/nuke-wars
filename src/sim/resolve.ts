// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// resolve(): the simulation engine's single entry point (spec §6). It takes the
// full, unfiltered state plus both players' orders and returns the next state
// together with the ordered event log clients animate from. In V1.5 this same
// function runs server-side and authoritative, unchanged.
//
// Build-order step 4 implements the skeleton and phase 5 (ground movement, §9).
// Phases 1–4 are stubs that name the step which fills each one. The five-phase
// order from spec §3 is already laid out below, because that order produces
// several deliberate consequences (strikes land before movement, so a launcher
// that fired cannot dodge the counter-battery) — getting it in place now means
// later steps drop into a slot rather than re-sequencing the round.
//
// DETERMINISM (spec §6): V1 resolution reads no randomness at all. The `_seed`
// parameter exists only so the signature doesn't have to change if V2
// reintroduces chance; the underscore is there to make reading it look as wrong
// as it is. Every remaining nondeterminism risk here is iteration order, which
// is why the two places order could leak in — conflict adjudication and event
// emission — are both pinned below.

import { RULES } from './defs';
import { hexKey, type Hex } from './hex';
import { validateMove, type MoveIllegalReason } from './movement';
import type {
  GameEvent,
  GameState,
  Order,
  PlayerId,
  ResolveResult,
  Unit,
  UnitId,
} from './types';

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
  orders: readonly Order[],
): { admitted: AdmittedMove[]; failed: UnitId[] } {
  const admitted: AdmittedMove[] = [];
  const failed: UnitId[] = [];

  for (const order of ordersByUnit(orders).values()) {
    // LAUNCH is build-order step 6, FLY is step 5. They are counted above (so
    // the one-order-per-unit rule is already correct) but not acted on here.
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
  ordersP1: readonly Order[],
  ordersP2: readonly Order[],
): { units: Unit[]; events: GameEvent[] } {
  const unitsById = new Map(state.units.map((unit) => [unit.id, unit]));

  const p1 = admitMoves(state, unitsById, 'p1', ordersP1);
  const p2 = admitMoves(state, unitsById, 'p2', ordersP2);

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

  // The five phases of spec §3 run in strict order, each one rebinding
  // `working` so the next always sees the board as the previous left it. That
  // is what will make §9's "movement is applied against the post-impact state"
  // true by construction once phase 3 exists, rather than a rule to remember.
  let working: GameState = state;

  // --- Phase 1: recon flight ------------------------------- build-order step 5
  // --- Phase 2: launch & interception ---------------------- build-order step 6
  // --- Phase 3: impact ------------------------------------- build-order step 6
  // --- Phase 4: outcome check ------------------------------ build-order step 7
  // Outcomes are evaluated only after a full resolution, never mid-round
  // (spec §5), and a destroyed real bunker skips phase 5 entirely (§3).

  // --- Phase 5: ground movement (spec §9) --------------------------------------
  const movement = runGroundMovement(working, ordersP1, ordersP2);
  working = { ...working, units: movement.units };
  events.push(...movement.events);

  return {
    state: {
      ...working,
      round: working.round + 1,
      phase: 'ORDER_PHASE',
    },
    events,
  };
}
