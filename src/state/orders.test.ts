import { describe, expect, it } from 'vitest';
import { RULES, UNIT_DEFS } from '../sim/defs';
import {
  axialToOffset,
  distance,
  hexKey,
  hexLine,
  hexesInRange,
  offsetToAxial,
  type Hex,
} from '../sim/hex';
import { generateMap, tileAt, type MapData, type TileData } from '../sim/map';
import { validateLaunch } from '../sim/missiles';
import { reachableHexes, validateMove } from '../sim/movement';
import { validateFly } from '../sim/recon';
import { startMatch } from '../sim/setup';
import type {
  LauncherContact,
  Order,
  PlayerId,
  Unit,
  UnitKind,
  VisibleGameState,
  VisiblePlayerIntel,
} from '../sim/types';
import { filterForPlayer } from '../sim/visibility';
import { believedState } from './belief';
import {
  allDecided,
  decidedCount,
  draftOrders,
  flyTargets,
  isLegalOrder,
  launchTargets,
  modesFor,
  moveTargets,
  orderFor,
  orderableUnits,
  withHold,
  withOrder,
  withoutOrder,
  EMPTY_DRAFT,
  type OrderDraft,
} from './orders';
import { sandboxSetup } from './sandbox';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An all-plains board the real size of a match map, so hand-placed units stay
 * comfortably on-map without fighting terrain generation. */
function plainsMap(width = 16, height = 19): MapData {
  const tiles: TileData[] = [];
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < height; row++) {
      tiles.push({ col, row, terrain: 'plains' });
    }
  }
  return { width, height, tiles };
}

/** The same board with one tile turned to mountain — the gotcha 7c fixture. */
function mapWithMountainAt(offset: { col: number; row: number }): MapData {
  const map = plainsMap();
  return {
    ...map,
    tiles: map.tiles.map((tile) =>
      tile.col === offset.col && tile.row === offset.row
        ? { ...tile, terrain: 'mountain' as const }
        : tile,
    ),
  };
}

function makeUnit(id: string, owner: PlayerId, kind: UnitKind, position: Hex): Unit {
  return { id, owner, kind, position, hp: UNIT_DEFS[kind].hp, destroyed: false };
}

function makeView(
  map: MapData,
  units: readonly Unit[],
  intel: Partial<VisiblePlayerIntel> = {},
  overrides: Partial<VisibleGameState> = {},
): VisibleGameState {
  return {
    round: 1,
    phase: 'ORDER_PHASE',
    map,
    units: [...units],
    intel: { staticReveals: [], contacts: [], ...intel },
    droneRespawnIn: 0,
    deadHandFor: null,
    outcome: null,
    ...overrides,
  };
}

function contact(hex: Hex): LauncherContact {
  return { hex, source: 'LAUNCH' };
}

/** A real match view, built the way the store builds one. */
function realView(seed = 42, player: PlayerId = 'p1'): VisibleGameState {
  const map = generateMap(undefined, undefined, seed);
  const truth = startMatch(map, {
    p1: sandboxSetup(map, 'p1'),
    p2: sandboxSetup(map, 'p2'),
  });
  return filterForPlayer(truth, player);
}

function keysOf(hexes: readonly Hex[]): Set<string> {
  return new Set(hexes.map(hexKey));
}

const CENTER = offsetToAxial({ col: 8, row: 9 });

// ---------------------------------------------------------------------------
// Which units may be ordered
// ---------------------------------------------------------------------------

describe('modesFor / orderableUnits', () => {
  it('offers MOVE and LAUNCH to a launcher and FLY to the drone, and nothing to a structure', () => {
    const launcher = makeUnit('p1-launcher-1', 'p1', 'launcher', CENTER);
    const drone = makeUnit('p1-drone', 'p1', 'drone', offsetToAxial({ col: 8, row: 12 }));
    const bunker = makeUnit('p1-bunker', 'p1', 'bunker', offsetToAxial({ col: 4, row: 16 }));
    const decoy = makeUnit('p1-decoy', 'p1', 'decoy', offsetToAxial({ col: 6, row: 16 }));
    const base = makeUnit('p1-interceptor-1', 'p1', 'interceptor', offsetToAxial({ col: 9, row: 15 }));
    const view = makeView(plainsMap(), [launcher, drone, bunker, decoy, base]);

    expect(modesFor(view, launcher)).toEqual(['MOVE', 'LAUNCH']);
    expect(modesFor(view, drone)).toEqual(['FLY']);

    // Spec §3: bunkers, decoys and bases are permanently static and act
    // passively. §12's indistinguishability principle in miniature — whatever
    // is true of the bunker here has to be true of the decoy.
    expect(modesFor(view, bunker)).toEqual([]);
    expect(modesFor(view, decoy)).toEqual([]);
    expect(modesFor(view, base)).toEqual([]);

    expect(orderableUnits(view).map((u) => u.id)).toEqual([launcher.id, drone.id]);
  });

  it('offers nothing to a wreck', () => {
    const dead = { ...makeUnit('p1-launcher-1', 'p1', 'launcher', CENTER), destroyed: true };
    const view = makeView(plainsMap(), [dead]);
    expect(modesFor(view, dead)).toEqual([]);
  });

  it('offers launches only in a dead-hand round, and only to the decapitated player', () => {
    const launcher = makeUnit('p1-launcher-1', 'p1', 'launcher', CENTER);
    const drone = makeUnit('p1-drone', 'p1', 'drone', offsetToAxial({ col: 8, row: 12 }));

    // Spec §3: the dead-hand round runs phases 2->3 only — no recon, no ground
    // movement — so a MOVE or a FLY is not a thing that can happen in it.
    const mine = makeView(plainsMap(), [launcher, drone], {}, {
      phase: 'DEAD_HAND_PHASE',
      deadHandFor: 'p1',
    });
    expect(modesFor(mine, launcher)).toEqual(['LAUNCH']);
    expect(modesFor(mine, drone)).toEqual([]);

    // "The opponent issues no orders at all" (§3).
    const theirs = makeView(plainsMap(), [launcher, drone], {}, {
      phase: 'DEAD_HAND_PHASE',
      deadHandFor: 'p2',
    });
    expect(orderableUnits(theirs)).toEqual([]);
  });

  it('offers nothing once the match is over', () => {
    const launcher = makeUnit('p1-launcher-1', 'p1', 'launcher', CENTER);
    const view = makeView(plainsMap(), [launcher], {}, {
      phase: 'GAME_OVER',
      outcome: { type: 'CAPITULATION', winner: 'p2' },
    });
    expect(orderableUnits(view)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Move targets
// ---------------------------------------------------------------------------

describe('moveTargets', () => {
  it('is exactly reachableHexes minus the launcher’s own hex', () => {
    const launcher = makeUnit('p1-launcher-1', 'p1', 'launcher', CENTER);
    const view = makeView(plainsMap(), [launcher]);

    const reachable = new Set(
      [...reachableHexes(believedState(view), launcher).values()]
        .map((r) => hexKey(r.hex))
        .filter((key) => key !== hexKey(launcher.position)),
    );

    expect(keysOf(moveTargets(view, launcher))).toEqual(reachable);
  });

  it('subtracts hexes the player can SEE are occupied (spec §9)', () => {
    const launcher = makeUnit('p1-launcher-1', 'p1', 'launcher', CENTER);
    const seen = offsetToAxial({ col: 8, row: 8 }); // one step north, plainly in range
    const view = makeView(plainsMap(), [launcher], { contacts: [contact(seen)] });

    // The flood fill offers it — `believedState` holds no enemy units at all, so
    // nothing in it can reject the hex. The subtraction is what does.
    const believed = believedState(view);
    expect(reachableHexes(believed, launcher).has(hexKey(seen))).toBe(true);

    // MUTATION GUARD: drop the `knownEnemyHexes` subtraction in moveTargets and
    // this flips to true, offering the player a hex they can see is occupied.
    expect(keysOf(moveTargets(view, launcher)).has(hexKey(seen))).toBe(false);

    // A permanent static reveal is subtracted the same way.
    const site = offsetToAxial({ col: 9, row: 9 });
    const withSite = makeView(plainsMap(), [launcher], {
      staticReveals: [{ hex: site, kind: 'bunker', round: 1 }],
    });
    expect(keysOf(moveTargets(withSite, launcher)).has(hexKey(site))).toBe(false);
  });

  it('still offers hexes holding an enemy the player has NOT detected', () => {
    // Spec §9: the order is legal, and fails entirely at resolution. That risk
    // is the reason flying the drone is worth a round — never design it away.
    const launcher = makeUnit('p1-launcher-1', 'p1', 'launcher', CENTER);
    const view = makeView(plainsMap(), [launcher]); // no intel at all
    const undetected = offsetToAxial({ col: 8, row: 8 });

    expect(keysOf(moveTargets(view, launcher)).has(hexKey(undetected))).toBe(true);
  });

  it('routes around mountains rather than measuring straight-line distance', () => {
    const launcher = makeUnit('p1-launcher-1', 'p1', 'launcher', CENTER);
    const blocked = offsetToAxial({ col: 8, row: 8 });
    const view = makeView(mapWithMountainAt(axialToOffset(blocked)), [launcher]);

    const targets = moveTargets(view, launcher);
    expect(keysOf(targets).has(hexKey(blocked))).toBe(false);
    // Everything offered is genuinely within the movement budget by COST, which
    // is not the same number as distance once terrain is in play.
    for (const hex of targets) {
      expect(distance(launcher.position, hex)).toBeLessThanOrEqual(
        UNIT_DEFS.launcher.movement,
      );
    }
  });

  it('offers nothing for a drone — the flood fill is never fed a flight range', () => {
    // CLAUDE.md gotcha 10. `reachableHexes` returns only the drone's own hex,
    // and MOVE is not a mode the drone is ever offered.
    const drone = makeUnit('p1-drone', 'p1', 'drone', CENTER);
    const view = makeView(plainsMap(), [drone]);
    expect(moveTargets(view, drone)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Launch targets
// ---------------------------------------------------------------------------

describe('launchTargets', () => {
  it('INCLUDES mountain hexes (spec §10, CLAUDE.md gotcha 7c)', () => {
    // The regression guard that matters most in this file. Structures may be
    // built on mountains (§2, §12), so a targeting rule that filtered
    // impassable ground would make a mountain bunker literally invulnerable.
    const launcher = makeUnit('p1-launcher-1', 'p1', 'launcher', CENTER);
    const peak = offsetToAxial({ col: 8, row: 6 }); // 3 north, inside range 6
    const view = makeView(mapWithMountainAt(axialToOffset(peak)), [launcher]);

    // MUTATION GUARD: add a `groundPassable` filter to launchTargets and this
    // fails.
    expect(keysOf(launchTargets(view, launcher)).has(hexKey(peak))).toBe(true);

    // And the sim agrees — the UI is not being more permissive than the engine.
    const order = orderFor(launcher, 'LAUNCH', peak);
    expect(isLegalOrder(view, order)).toBe(true);

    // The same hex is NOT a legal move, which is the whole asymmetry.
    expect(keysOf(moveTargets(view, launcher)).has(hexKey(peak))).toBe(false);
  });

  it('excludes the launcher’s own hex (SAME_HEX) and everything off the map', () => {
    const launcher = makeUnit('p1-launcher-1', 'p1', 'launcher', offsetToAxial({ col: 0, row: 0 }));
    const map = plainsMap();
    const view = makeView(map, [launcher]);

    const targets = launchTargets(view, launcher);
    expect(keysOf(targets).has(hexKey(launcher.position))).toBe(false);

    // A corner launcher is the case that catches an unfiltered `hexesInRange`
    // (gotcha 37) — most of its range ring is off the board.
    for (const hex of targets) {
      const { col, row } = axialToOffset(hex);
      expect(col).toBeGreaterThanOrEqual(0);
      expect(row).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(map.width);
      expect(row).toBeLessThan(map.height);
    }
  });

  it('offers blind fire at hexes holding nothing the player can see', () => {
    // Spec §3: blind fire is the norm, not the exception.
    const launcher = makeUnit('p1-launcher-1', 'p1', 'launcher', CENTER);
    const view = makeView(plainsMap(), [launcher]);
    expect(launchTargets(view, launcher).length).toBeGreaterThan(0);
  });

  it('never subtracts known enemy hexes — firing at one is the point', () => {
    const launcher = makeUnit('p1-launcher-1', 'p1', 'launcher', CENTER);
    const seen = offsetToAxial({ col: 8, row: 7 });
    const view = makeView(plainsMap(), [launcher], { contacts: [contact(seen)] });

    expect(keysOf(launchTargets(view, launcher)).has(hexKey(seen))).toBe(true);
    expect(keysOf(moveTargets(view, launcher)).has(hexKey(seen))).toBe(false);
  });

  it('reaches exactly RULES.missileRange, further than the launcher can drive', () => {
    const launcher = makeUnit('p1-launcher-1', 'p1', 'launcher', CENTER);
    const view = makeView(plainsMap(), [launcher]);

    for (const hex of launchTargets(view, launcher)) {
      expect(distance(launcher.position, hex)).toBeLessThanOrEqual(RULES.missileRange);
    }
    expect(launchTargets(view, launcher).length).toBeGreaterThan(
      moveTargets(view, launcher).length,
    );
  });
});

// ---------------------------------------------------------------------------
// Fly targets
// ---------------------------------------------------------------------------

describe('flyTargets', () => {
  it('is a straight-line flight range, not the ground flood fill (gotcha 10)', () => {
    const drone = makeUnit('p1-drone', 'p1', 'drone', CENTER);
    const wall = offsetToAxial({ col: 8, row: 8 });
    const beyond = offsetToAxial({ col: 8, row: 6 });
    const view = makeView(mapWithMountainAt(axialToOffset(wall)), [drone]);

    const targets = keysOf(flyTargets(view, drone));
    // The drone crosses terrain and units alike (spec §11), so a mountain is
    // both a legal destination and no obstacle to what lies past it.
    expect(targets.has(hexKey(wall))).toBe(true);
    expect(targets.has(hexKey(beyond))).toBe(true);

    // And it reaches 6, where a ground unit's budget is 3.
    const reach = Math.max(
      ...flyTargets(view, drone).map((hex) => distance(drone.position, hex)),
    );
    expect(reach).toBe(UNIT_DEFS.drone.movement);
  });

  it('excludes the drone’s own hex — "give no order to hover" (spec §11)', () => {
    const drone = makeUnit('p1-drone', 'p1', 'drone', CENTER);
    const view = makeView(plainsMap(), [drone]);
    expect(keysOf(flyTargets(view, drone)).has(hexKey(drone.position))).toBe(false);
    expect(isLegalOrder(view, orderFor(drone, 'FLY', drone.position))).toBe(false);
  });

  it('offers nothing for a launcher', () => {
    const launcher = makeUnit('p1-launcher-1', 'p1', 'launcher', CENTER);
    const view = makeView(plainsMap(), [launcher]);
    expect(flyTargets(view, launcher)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Illegal orders
// ---------------------------------------------------------------------------

describe('illegal orders are refused, never stored', () => {
  const drone = makeUnit('p1-drone', 'p1', 'drone', CENTER);
  const launcher = makeUnit('p1-launcher-1', 'p1', 'launcher', offsetToAxial({ col: 8, row: 12 }));
  const view = makeView(plainsMap(), [launcher, drone]);
  const somewhere = offsetToAxial({ col: 8, row: 11 });

  it('refuses a MOVE naming the drone (AIR_UNIT)', () => {
    const order: Order = { type: 'MOVE', unitId: drone.id, destination: somewhere };
    expect(validateMove(believedState(view), 'p1', order)).toEqual({
      legal: false,
      reason: 'AIR_UNIT',
    });
    expect(isLegalOrder(view, order)).toBe(false);
    expect(withOrder(view, EMPTY_DRAFT, order)).toBe(EMPTY_DRAFT);
  });

  it('refuses a LAUNCH naming the drone (NOT_A_LAUNCHER)', () => {
    const order: Order = { type: 'LAUNCH', unitId: drone.id, target: somewhere };
    expect(validateLaunch(believedState(view), 'p1', order)).toEqual({
      legal: false,
      reason: 'NOT_A_LAUNCHER',
    });
    expect(isLegalOrder(view, order)).toBe(false);
    expect(withOrder(view, EMPTY_DRAFT, order)).toBe(EMPTY_DRAFT);
  });

  it('refuses a FLY naming a launcher (NOT_AIR_UNIT)', () => {
    const order: Order = { type: 'FLY', unitId: launcher.id, destination: somewhere };
    expect(validateFly(believedState(view), 'p1', order)).toEqual({
      legal: false,
      reason: 'NOT_AIR_UNIT',
    });
    expect(withOrder(view, EMPTY_DRAFT, order)).toBe(EMPTY_DRAFT);
  });

  it('refuses an order naming a unit that is not the viewer’s', () => {
    // A VisibleGameState holds only its owner's units (spec §6), so "you may
    // only order your own pieces" needs no check — the lookup simply fails.
    const order: Order = {
      type: 'MOVE',
      unitId: 'p2-launcher-1',
      destination: somewhere,
    };
    expect(isLegalOrder(view, order)).toBe(false);
    expect(withOrder(view, EMPTY_DRAFT, order)).toBe(EMPTY_DRAFT);
  });

  it('refuses a MOVE during the dead-hand round, which the sim validator alone would allow', () => {
    // The sim's validators know nothing about phases; §3's "launches only" is a
    // phase rule, so `modesFor` has to carry it.
    const deadHand = makeView(plainsMap(), [launcher, drone], {}, {
      phase: 'DEAD_HAND_PHASE',
      deadHandFor: 'p1',
    });
    const order: Order = { type: 'MOVE', unitId: launcher.id, destination: somewhere };

    expect(validateMove(believedState(deadHand), 'p1', order).legal).toBe(true);
    expect(isLegalOrder(deadHand, order)).toBe(false);
    expect(withOrder(deadHand, EMPTY_DRAFT, order)).toBe(EMPTY_DRAFT);
  });

  it('refuses a move out of range', () => {
    const far = offsetToAxial({ col: 8, row: 0 });
    const order: Order = { type: 'MOVE', unitId: launcher.id, destination: far };
    expect(isLegalOrder(view, order)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

describe('OrderDraft', () => {
  const launcher = makeUnit('p1-launcher-1', 'p1', 'launcher', CENTER);
  const drone = makeUnit('p1-drone', 'p1', 'drone', offsetToAxial({ col: 8, row: 12 }));
  const view = makeView(plainsMap(), [launcher, drone]);

  it('REPLACES a unit’s order instead of appending (RULES.ordersPerUnit, spec §9)', () => {
    // The structural version of "a unit given more than one order does nothing".
    const move = orderFor(launcher, 'MOVE', offsetToAxial({ col: 8, row: 8 }));
    const fire = orderFor(launcher, 'LAUNCH', offsetToAxial({ col: 8, row: 5 }));

    let draft: OrderDraft = withOrder(view, EMPTY_DRAFT, move);
    draft = withOrder(view, draft, fire);

    expect(Object.keys(draft)).toEqual([launcher.id]);
    expect(draftOrders(draft)).toEqual([fire]);
    expect(RULES.ordersPerUnit).toBe(1);
  });

  it('never submits more orders than the round has orderable units', () => {
    let draft: OrderDraft = EMPTY_DRAFT;
    for (const unit of orderableUnits(view)) {
      for (const mode of modesFor(view, unit)) {
        const target = { MOVE: moveTargets, LAUNCH: launchTargets, FLY: flyTargets }[
          mode
        ](view, unit)[0];
        draft = withOrder(view, draft, orderFor(unit, mode, target));
      }
    }
    expect(draftOrders(draft).length).toBeLessThanOrEqual(orderableUnits(view).length);
  });

  it('strips HOLD entries — a hold is the empty submission (spec §3)', () => {
    const move = orderFor(launcher, 'MOVE', offsetToAxial({ col: 8, row: 8 }));
    const draft = withHold(view, withOrder(view, EMPTY_DRAFT, move), drone);

    expect(decidedCount(view, draft)).toBe(2);
    // The engine never learns HOLD exists: a unit it receives no order for
    // holds anyway, so a hold IS submitting nothing for that unit.
    expect(draftOrders(draft)).toEqual([move]);
  });

  it('refuses a hold for a unit that cannot be ordered', () => {
    const bunker = makeUnit('p1-bunker', 'p1', 'bunker', offsetToAxial({ col: 4, row: 16 }));
    const withBunker = makeView(plainsMap(), [launcher, drone, bunker]);
    expect(withHold(withBunker, EMPTY_DRAFT, bunker)).toBe(EMPTY_DRAFT);
  });

  it('withoutOrder puts a unit back to undecided', () => {
    const move = orderFor(launcher, 'MOVE', offsetToAxial({ col: 8, row: 8 }));
    const draft = withOrder(view, EMPTY_DRAFT, move);
    expect(withoutOrder(draft, launcher.id)).toEqual({});
    expect(withoutOrder(draft, 'nobody')).toBe(draft);
  });
});

// ---------------------------------------------------------------------------
// allDecided — the auto-resolve trigger
// ---------------------------------------------------------------------------

describe('allDecided', () => {
  const launcher = makeUnit('p1-launcher-1', 'p1', 'launcher', CENTER);
  const drone = makeUnit('p1-drone', 'p1', 'drone', offsetToAxial({ col: 8, row: 12 }));
  const view = makeView(plainsMap(), [launcher, drone]);

  it('is false until every orderable unit has a decision, then true', () => {
    expect(allDecided(view, EMPTY_DRAFT)).toBe(false);

    const one = withHold(view, EMPTY_DRAFT, launcher);
    expect(allDecided(view, one)).toBe(false);

    const both = withHold(view, one, drone);
    expect(allDecided(view, both)).toBe(true);
  });

  it('is FALSE when there is nothing to order, not vacuously true', () => {
    // The load-bearing guard. During the opponent's dead-hand round the viewer
    // has no orderable units, and "every one of zero units is decided" would
    // otherwise resolve the round forever.
    const spectating = makeView(plainsMap(), [launcher, drone], {}, {
      phase: 'DEAD_HAND_PHASE',
      deadHandFor: 'p2',
    });
    expect(orderableUnits(spectating)).toEqual([]);
    expect(allDecided(spectating, EMPTY_DRAFT)).toBe(false);

    const over = makeView(plainsMap(), [launcher, drone], {}, {
      phase: 'GAME_OVER',
      outcome: { type: 'CAPITULATION', winner: 'p2' },
    });
    expect(allDecided(over, EMPTY_DRAFT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The end-to-end promise, on a real generated board
// ---------------------------------------------------------------------------

describe('on a real match board', () => {
  it('every target the UI offers produces an order the sim validators accept', () => {
    // The contract the whole module rests on: whatever the player is allowed to
    // click, the engine will accept. Checked against belief, which is what the
    // store validates against — truth may still disagree at resolution, and
    // spec §9 says that is the intended risk, not a defect.
    const view = realView();
    const believed = believedState(view);

    let checked = 0;
    for (const unit of orderableUnits(view)) {
      for (const mode of modesFor(view, unit)) {
        const targets = { MOVE: moveTargets, LAUNCH: launchTargets, FLY: flyTargets }[
          mode
        ](view, unit);
        expect(targets.length).toBeGreaterThan(0);

        for (const hex of targets) {
          const order = orderFor(unit, mode, hex);
          const check =
            order.type === 'MOVE'
              ? validateMove(believed, unit.owner, order)
              : order.type === 'LAUNCH'
                ? validateLaunch(believed, unit.owner, order)
                : validateFly(believed, unit.owner, order);

          expect(check.legal).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('a full draft decides every orderable unit and submits at most one order each', () => {
    const view = realView();

    let draft: OrderDraft = EMPTY_DRAFT;
    for (const unit of orderableUnits(view)) {
      const mode = modesFor(view, unit)[0];
      const target = { MOVE: moveTargets, LAUNCH: launchTargets, FLY: flyTargets }[
        mode
      ](view, unit)[0];
      draft = withOrder(view, draft, orderFor(unit, mode, target));
    }

    expect(allDecided(view, draft)).toBe(true);
    const orders = draftOrders(draft);
    expect(orders).toHaveLength(orderableUnits(view).length);
    expect(new Set(orders.map((o) => o.unitId)).size).toBe(orders.length);
  });

  it('a legal flight’s path and swath DO spill off the board — so the render layer must filter', () => {
    // CLAUDE.md gotcha 37, kept alive as an assertion rather than a comment.
    // The map is a rectangle in col/row and a slanted parallelogram in axial, so
    // a straight line between two on-map hexes can leave the board, and a swath
    // certainly does. `drawOrders` filters every hex through `tileAt` for this
    // reason; if that filter is ever deleted the overlay paints ground that does
    // not exist, and no test that only checks target lists would notice.
    const view = realView();
    const drone = orderableUnits(view).find((u) => u.kind === 'drone');
    if (!drone) throw new Error('no drone');

    const offBoard = flyTargets(view, drone).flatMap((target) => {
      const path = hexLine(drone.position, target);
      const drawn: Hex[] = [...path];
      for (const step of path) {
        drawn.push(...hexesInRange(step, RULES.reconSwathRadius));
      }
      return drawn.filter((hex) => tileAt(view.map, axialToOffset(hex)) === undefined);
    });

    expect(offBoard.length).toBeGreaterThan(0);
  });

  it('is deterministic — the same view offers the same targets in the same order', () => {
    const view = realView();
    const launcher = orderableUnits(view).find((u) => u.kind === 'launcher');
    if (!launcher) throw new Error('no launcher');

    expect(moveTargets(view, launcher)).toEqual(moveTargets(view, launcher));
    expect(launchTargets(view, launcher)).toEqual(launchTargets(view, launcher));
  });
});
