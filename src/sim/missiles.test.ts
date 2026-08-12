import { describe, expect, it } from 'vitest';
import { basesCovering } from './coverage';
import { RULES, UNIT_DEFS } from './defs';
import {
  axialToOffset,
  compareHex,
  distance,
  hexKey,
  hexLine,
  neighbors,
  offsetToAxial,
  type Hex,
} from './hex';
import { tileAt, type MapData, type Terrain, type TileData } from './map';
import {
  canonicalOrder,
  createMissile,
  damageByHex,
  flyMissiles,
  missileIdFor,
  validateLaunch,
  type Missile,
} from './missiles';
import type { GameState, LaunchOrder, PlayerId, Unit, UnitKind } from './types';

// --- fixtures ---------------------------------------------------------------
//
// Same approach as movement.test.ts, recon.test.ts and resolve.test.ts:
// synthetic all-plains maps rather than generateMap(), so terrain is controlled
// rather than seed-dependent. The fill order must match generateMap's
// column-major order for tileAt's index math to hold.

function makeMap(width: number, height: number): MapData {
  const tiles: TileData[] = [];
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < height; row++) {
      tiles.push({ col, row, terrain: 'plains' });
    }
  }
  return { width, height, tiles };
}

function setTerrain(map: MapData, hex: Hex, terrain: Terrain): void {
  const tile = tileAt(map, axialToOffset(hex));
  if (!tile) throw new Error(`test fixture put ${hexKey(hex)} off-map`);
  tile.terrain = terrain;
}

function makeUnit(
  id: string,
  owner: PlayerId,
  kind: UnitKind,
  position: Hex,
): Unit {
  return { id, owner, kind, position, hp: UNIT_DEFS[kind].hp, destroyed: false };
}

function makeState(map: MapData, units: Unit[]): GameState {
  return {
    round: 1,
    phase: 'ORDER_PHASE',
    map,
    units,
    intel: {
      p1: { staticReveals: [], contacts: [] },
      p2: { staticReveals: [], contacts: [] },
    },
    droneRespawnIn: { p1: 0, p2: 0 },
    deadHandFor: null,
    outcome: null,
  };
}

function openField(units: Unit[] = []): GameState {
  return makeState(makeMap(21, 21), units);
}

/** A LAUNCH order, so the validator is called with the same shape resolve() passes. */
function aim(unitId: string, target: Hex): LaunchOrder {
  return { type: 'LAUNCH', unitId, target };
}

/** A hex comfortably inside a 21x21 map, so edge clipping never interferes. */
const CENTER: Hex = offsetToAxial({ col: 10, row: 10 });

/** Missile range, read from the balance table rather than hardcoded. */
const RANGE = RULES.missileRange;

/** A hex exactly `steps` away, walking due north (up the board's long axis). */
function north(from: Hex, steps: number): Hex {
  return offsetToAxial({
    col: axialToOffset(from).col,
    row: axialToOffset(from).row - steps,
  });
}

// --- validateLaunch (spec §3, §10) ------------------------------------------

describe('validateLaunch()', () => {
  const launcher = makeUnit('a', 'p1', 'launcher', CENTER);

  it('accepts a target inside range and reports the distance flown', () => {
    const state = openField([launcher]);

    expect(validateLaunch(state, 'p1', aim('a', north(CENTER, RANGE))))
      .toEqual({ legal: true, distance: RANGE });
  });

  it('accepts blind fire at an empty hex — no target needs to be visible', () => {
    const state = openField([launcher]);
    const empty = north(CENTER, 3);

    expect(state.units.some((u) => hexKey(u.position) === hexKey(empty))).toBe(false);
    expect(validateLaunch(state, 'p1', aim('a', empty)).legal).toBe(true);
  });

  it('accepts a MOUNTAIN target — missiles ignore terrain in targeting (§10)', () => {
    const state = openField([launcher]);
    const peak = north(CENTER, 2);
    setTerrain(state.map, peak, 'mountain');

    // Load-bearing, not an oversight: static structures may be built on
    // mountains (§12), so a targeting rule that filtered impassable hexes would
    // make a mountain bunker literally invulnerable.
    expect(validateLaunch(state, 'p1', aim('a', peak)).legal).toBe(true);
  });

  it('rejects a target one hex past the missile’s range', () => {
    const state = openField([launcher]);

    expect(validateLaunch(state, 'p1', aim('a', north(CENTER, RANGE + 1))))
      .toEqual({ legal: false, reason: 'OUT_OF_RANGE' });
  });

  it('rejects the launcher’s own hex (§3 — this is not a no-op)', () => {
    const state = openField([launcher]);

    expect(validateLaunch(state, 'p1', aim('a', CENTER))).toEqual({
      legal: false,
      reason: 'SAME_HEX',
    });
  });

  it('rejects a target off the edge of the map', () => {
    const state = openField([launcher]);

    expect(validateLaunch(state, 'p1', aim('a', offsetToAxial({ col: -3, row: -3 }))))
      .toEqual({ legal: false, reason: 'OFF_MAP' });
  });

  it.each<[UnitKind, string]>([
    ['drone', 'the drone carries no missile'],
    ['interceptor', 'a base defends, it does not fire'],
    ['bunker', 'the leader piece is passive'],
    ['decoy', 'empty concrete'],
  ])('rejects a LAUNCH naming a %s — %s', (kind) => {
    const state = openField([makeUnit('x', 'p1', kind, CENTER)]);

    expect(validateLaunch(state, 'p1', aim('x', north(CENTER, 2))))
      .toEqual({ legal: false, reason: 'NOT_A_LAUNCHER' });
  });

  it('rejects an order naming the ENEMY’s launcher', () => {
    const state = openField([makeUnit('z', 'p2', 'launcher', CENTER)]);

    expect(validateLaunch(state, 'p1', aim('z', north(CENTER, 2))))
      .toEqual({ legal: false, reason: 'NOT_YOUR_UNIT' });
  });

  it('rejects an order naming a unit that does not exist', () => {
    const state = openField([launcher]);

    expect(validateLaunch(state, 'p1', aim('ghost', north(CENTER, 2))))
      .toEqual({ legal: false, reason: 'UNKNOWN_UNIT' });
  });

  it('rejects a destroyed launcher — wrecks do not shoot', () => {
    const wreck = makeUnit('a', 'p1', 'launcher', CENTER);
    wreck.destroyed = true;

    expect(validateLaunch(openField([wreck]), 'p1', aim('a', north(CENTER, 2))))
      .toEqual({ legal: false, reason: 'UNIT_DESTROYED' });
  });
});

// --- missile identity (spec §6) ---------------------------------------------

describe('missileIdFor()', () => {
  it('is built from the round and the origin hex, both public', () => {
    // LAUNCH_DETECTED publishes origin and round to both players, so the id
    // tells the enemy nothing they were not already handed.
    expect(missileIdFor(4, CENTER)).toBe(`r4@${hexKey(CENTER)}`);
  });

  it('distinguishes the same launcher’s missiles across rounds', () => {
    expect(missileIdFor(4, CENTER)).not.toBe(missileIdFor(5, CENTER));
  });

  it('is unique within a round, because no two launchers share a hex', () => {
    const ids = new Set(
      [CENTER, north(CENTER, 1), north(CENTER, 2)].map((hex) => missileIdFor(3, hex)),
    );

    expect(ids.size).toBe(3);
  });

  it('never contains the firing launcher’s id (§11 — no trackable identity)', () => {
    const launcher = makeUnit('launcher-p1-secret', 'p1', 'launcher', CENTER);
    const missile = createMissile(2, launcher, north(CENTER, 3));

    expect(missile.id).not.toContain(launcher.id);
  });
});

// --- flight geometry (spec §10) ---------------------------------------------

describe('createMissile()', () => {
  const launcher = makeUnit('a', 'p1', 'launcher', CENTER);
  const target = north(CENTER, 4);

  it('checks every hex AFTER the origin, target included', () => {
    const missile = createMissile(1, launcher, target);

    expect(missile.path).toEqual(hexLine(CENTER, target).slice(1));
    expect(missile.path).not.toContainEqual(CENTER);
    expect(missile.path[missile.path.length - 1]).toEqual(target);
  });

  it('flies the shared hexLine primitive, never a re-derived path', () => {
    // Both endpoints get the pinned epsilon nudge (§10). If this file drew its
    // own line, a grazing shot could take a different route in the sim than in
    // the UI preview.
    const skew = createMissile(1, launcher, offsetToAxial({ col: 13, row: 7 }));

    expect(skew.path).toEqual(hexLine(CENTER, offsetToAxial({ col: 13, row: 7 })).slice(1));
  });

  it('records the owner and origin from the firing launcher', () => {
    const missile = createMissile(7, launcher, target);

    expect(missile.owner).toBe('p1');
    expect(missile.origin).toEqual(CENTER);
    expect(missile.id).toBe(missileIdFor(7, CENTER));
  });
});

// --- which base engages (spec §10) ------------------------------------------

describe('basesCovering()', () => {
  it('returns only LIVING ENEMY bases, in ascending base-id order', () => {
    const dead = makeUnit('a-dead', 'p2', 'interceptor', CENTER);
    dead.destroyed = true;
    const units = [
      makeUnit('z-enemy', 'p2', 'interceptor', CENTER),
      makeUnit('b-enemy', 'p2', 'interceptor', neighbors(CENTER)[0]),
      makeUnit('c-friendly', 'p1', 'interceptor', CENTER),
      dead,
    ];

    expect(basesCovering(units, CENTER, 'p1').map((b) => b.id)).toEqual([
      'b-enemy',
      'z-enemy',
    ]);
  });

  it('is empty for a hex outside every bubble', () => {
    const units = [makeUnit('base', 'p2', 'interceptor', CENTER)];
    const far = north(CENTER, RULES.interceptorCoverageRadius + 1);

    expect(basesCovering(units, far, 'p1')).toEqual([]);
  });
});

// --- interception (spec §10) ------------------------------------------------

describe('flyMissiles()', () => {
  /** A p1 launcher at CENTER firing due north at `steps`. */
  function shot(steps: number, at: Hex = CENTER, owner: PlayerId = 'p1'): Missile {
    return createMissile(1, makeUnit(`${owner}-${hexKey(at)}`, owner, 'launcher', at), north(at, steps));
  }

  /**
   * The flight step at which a missile first enters `base`'s bubble, or -1.
   * Used to guard the fixtures below: several of these tests only mean what they
   * claim if two missiles arrive on the same step (a genuine tie) or on
   * different ones (a race), so the premise is asserted rather than assumed.
   */
  function entryStep(missile: Missile, base: Unit): number {
    return missile.path.findIndex(
      (hex) => basesCovering([base], hex, missile.owner).length > 0,
    );
  }

  it('lets a missile through when nothing covers its lane', () => {
    const missile = shot(4);

    const flights = flyMissiles([], [missile]);

    expect(flights.survivors).toEqual([missile]);
    expect(flights.interceptions).toEqual([]);
  });

  it('destroys a missile on the first covered hex it enters', () => {
    const missile = shot(RANGE);
    const base = makeUnit('base', 'p2', 'interceptor', north(CENTER, 3));

    const flights = flyMissiles([base], [missile]);

    // Coverage radius 1, so the bubble starts at the hex before the base.
    expect(flights.survivors).toEqual([]);
    expect(flights.interceptions).toEqual([{ missile, hex: north(CENTER, 2) }]);
  });

  it('never engages a missile on its ORIGIN hex', () => {
    // An enemy base one hex south of the launcher covers the launcher's own hex,
    // but the missile flies north — so the first hex it ENTERS is two hexes from
    // the base and clear. Keeping the origin in the path would shoot the missile
    // down before it left the rail.
    const base = makeUnit('base', 'p2', 'interceptor', north(CENTER, -1));
    const missile = shot(3);

    expect(distance(base.position, CENTER)).toBeLessThanOrEqual(
      RULES.interceptorCoverageRadius,
    );
    expect(flyMissiles([base], [missile]).survivors).toEqual([missile]);
  });

  it('spends a base’s capacity — the second missile through the lane lands', () => {
    // §10's saturation rule, and the reason the per-round cap exists: without
    // it, bases would be unkillable and a launcher parked in a bubble
    // permanently safe.
    expect(RULES.interceptsPerRound).toBe(1);
    const base = makeUnit('base', 'p2', 'interceptor', north(CENTER, 3));
    const west = offsetToAxial({ col: 9, row: 10 });
    const volley = [shot(RANGE), shot(RANGE, west)];

    const flights = flyMissiles([base], volley);

    expect(flights.interceptions).toHaveLength(1);
    expect(flights.survivors).toHaveLength(1);
  });

  it('two bases covering one lane can stop two missiles', () => {
    const bases = [
      makeUnit('base-1', 'p2', 'interceptor', north(CENTER, 3)),
      makeUnit('base-2', 'p2', 'interceptor', north(CENTER, 4)),
    ];
    const west = offsetToAxial({ col: 9, row: 10 });

    const flights = flyMissiles(bases, [shot(RANGE), shot(RANGE, west)]);

    expect(flights.survivors).toEqual([]);
    expect(flights.interceptions).toHaveLength(2);
  });

  it('never engages its owner’s own missiles', () => {
    const friendly = makeUnit('base', 'p1', 'interceptor', north(CENTER, 3));
    const missile = shot(RANGE);

    expect(flyMissiles([friendly], [missile]).survivors).toEqual([missile]);
  });

  it('a destroyed base leaves no bubble behind', () => {
    const base = makeUnit('base', 'p2', 'interceptor', north(CENTER, 3));
    base.destroyed = true;
    const missile = shot(RANGE);

    expect(flyMissiles([base], [missile]).survivors).toEqual([missile]);
  });

  it('breaks a same-step tie by ORIGIN HEX, never by launcher id (§10)', () => {
    // Two missiles reach one base's bubble on the same step. Only one can be
    // engaged, and the winner is decided by the public origin hex — the
    // launcher ids here are deliberately ordered the OTHER way, so an
    // implementation that sorted by id would fail this test.
    const base = makeUnit('base', 'p2', 'interceptor', north(CENTER, 4));
    const westHex = offsetToAxial({ col: 9, row: 10 });
    const eastHex = offsetToAxial({ col: 11, row: 10 });
    const first = createMissile(1, makeUnit('zzz', 'p1', 'launcher', westHex), north(westHex, RANGE));
    const second = createMissile(1, makeUnit('aaa', 'p1', 'launcher', eastHex), north(eastHex, RANGE));

    expect(compareHex(first.origin, second.origin)).toBeLessThan(0);
    expect(first.launcherId > second.launcherId).toBe(true);
    // The premise: this is a real tie. If one arrived a step earlier the test
    // would pass without ever exercising the tiebreak.
    expect(entryStep(first, base)).toBe(entryStep(second, base));

    const flights = flyMissiles([base], [second, first]);

    expect(flights.interceptions.map((i) => i.missile.id)).toEqual([first.id]);
    expect(flights.survivors.map((m) => m.id)).toEqual([second.id]);
  });

  it('engages the nearer missile first, whatever order it was handed', () => {
    // Step-wise simultaneity, not flight-by-flight: the base spends its single
    // intercept on whichever missile ENTERS the bubble first. Resolving one
    // whole flight at a time would award it to whoever was listed first.
    const base = makeUnit('base', 'p2', 'interceptor', north(CENTER, 6));
    const near = createMissile(
      1,
      makeUnit('near', 'p1', 'launcher', north(CENTER, 4)),
      north(CENTER, RANGE + 4),
    );
    const far = shot(RANGE);

    // The premise: 'near' reaches the bubble on an earlier step than 'far'.
    expect(entryStep(near, base)).toBeLessThan(entryStep(far, base));

    const flights = flyMissiles([base], [far, near]);

    expect(flights.interceptions.map((i) => i.missile.id)).toEqual([near.id]);
  });

  it('returns survivors in canonical order regardless of input order', () => {
    const west = offsetToAxial({ col: 8, row: 10 });
    const east = offsetToAxial({ col: 12, row: 10 });
    const a = shot(3, west);
    const b = shot(3, east);

    expect(flyMissiles([], [b, a]).survivors.map((m) => m.id)).toEqual(
      canonicalOrder([a, b]).map((m) => m.id),
    );
  });
});

// --- stacking damage (spec §3) ----------------------------------------------

describe('damageByHex()', () => {
  const launcher = makeUnit('a', 'p1', 'launcher', CENTER);

  it('totals hits per hex — two missiles on one hex stack to 2', () => {
    const target = north(CENTER, 3);
    const other = makeUnit('b', 'p1', 'launcher', offsetToAxial({ col: 8, row: 10 }));

    const totals = damageByHex([
      createMissile(1, launcher, target),
      createMissile(1, other, target),
    ]);

    // A 2-missile alpha strike kills a full-health bunker outright, skipping the
    // decoy test at the price of a wasted missile if the site is the fake (§12).
    expect(totals.get(hexKey(target))).toBe(2 * RULES.missileDamage);
    expect(totals.size).toBe(1);
  });

  it('is empty when nothing survived to land', () => {
    expect(damageByHex([]).size).toBe(0);
  });
});
