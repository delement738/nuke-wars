import { describe, expect, it } from 'vitest';
import { UNIT_DEFS } from './defs';
import { axialToOffset, offsetToAxial, type Hex } from './hex';
import type { MapData, TileData } from './map';
import { resolve } from './resolve';
import type {
  GameEvent,
  GameState,
  PlayerId,
  Unit,
  UnitKind,
} from './types';
import { filterEventsForPlayer, filterForPlayer } from './visibility';

// --- fixtures ---------------------------------------------------------------
//
// Same approach as resolve.test.ts: synthetic all-plains maps rather than
// generateMap(), so terrain is controlled rather than seed-dependent. The fill
// order must match generateMap's column-major order for tileAt's index math.

function makeMap(width: number, height: number): MapData {
  const tiles: TileData[] = [];
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < height; row++) {
      tiles.push({ col, row, terrain: 'plains' });
    }
  }
  return { width, height, tiles };
}

function makeUnit(
  id: string,
  owner: PlayerId,
  kind: UnitKind,
  position: Hex,
  destroyed = false,
): Unit {
  return {
    id,
    owner,
    kind,
    position,
    hp: destroyed ? 0 : UNIT_DEFS[kind].hp,
    destroyed,
  };
}

function makeState(
  units: Unit[],
  overrides: Partial<GameState> = {},
): GameState {
  return {
    round: 1,
    phase: 'ORDER_PHASE',
    map: makeMap(21, 21),
    units,
    intel: {
      p1: { staticReveals: [], contacts: [] },
      p2: { staticReveals: [], contacts: [] },
    },
    droneRespawnIn: { p1: 0, p2: 0 },
    deadHandFor: null,
    outcome: null,
    ...overrides,
  };
}

/** A hex comfortably inside a 21x21 map, so edge clipping never interferes. */
const CENTER: Hex = offsetToAxial({ col: 10, row: 10 });

/** A hex exactly `steps` away, walking due north (up the board's long axis). */
function north(from: Hex, steps: number): Hex {
  const offset = axialToOffset(from);
  return offsetToAxial({ col: offset.col, row: offset.row - steps });
}

/** Both players' views of the same state, so a test can assert on the pair. */
function bothViews(state: GameState) {
  return { p1: filterForPlayer(state, 'p1'), p2: filterForPlayer(state, 'p2') };
}

/** Which players an event survives filtering for. */
function audience(event: GameEvent): PlayerId[] {
  return (['p1', 'p2'] as PlayerId[]).filter(
    (player) => filterEventsForPlayer([event], player).length === 1,
  );
}

// ---------------------------------------------------------------------------
// filterForPlayer — units
// ---------------------------------------------------------------------------

describe('filterForPlayer() — units', () => {
  it('keeps every one of the viewer’s own units', () => {
    const state = makeState([
      makeUnit('p1-launcher', 'p1', 'launcher', CENTER),
      makeUnit('p1-bunker', 'p1', 'bunker', north(CENTER, 2)),
      makeUnit('p1-decoy', 'p1', 'decoy', north(CENTER, 3)),
    ]);

    expect(filterForPlayer(state, 'p1').units.map((u) => u.id)).toEqual([
      'p1-launcher',
      'p1-bunker',
      'p1-decoy',
    ]);
  });

  it('drops every enemy unit rather than masking it', () => {
    // The enemy is absent from `units`, not downgraded into it. Nothing this
    // player knows about the enemy lives here — it is all in `intel`, keyed by
    // hex, so there is no field that could carry an enemy UnitId (spec §11).
    const state = makeState([
      makeUnit('p1-launcher', 'p1', 'launcher', CENTER),
      makeUnit('p2-launcher', 'p2', 'launcher', north(CENTER, 4)),
      makeUnit('p2-bunker', 'p2', 'bunker', north(CENTER, 5)),
    ]);

    const views = bothViews(state);
    expect(views.p1.units.map((u) => u.id)).toEqual(['p1-launcher']);
    expect(views.p2.units.map((u) => u.id)).toEqual([
      'p2-launcher',
      'p2-bunker',
    ]);
  });

  it('drops enemy units even when the viewer has already spotted them', () => {
    // Spotting an asset puts a marker on your map, never a unit in your army.
    const state = makeState(
      [makeUnit('p2-bunker', 'p2', 'bunker', north(CENTER, 5))],
      {
        intel: {
          p1: {
            staticReveals: [
              { hex: north(CENTER, 5), kind: 'bunker', round: 1 },
            ],
            contacts: [],
          },
          p2: { staticReveals: [], contacts: [] },
        },
      },
    );

    expect(filterForPlayer(state, 'p1').units).toEqual([]);
    expect(filterForPlayer(state, 'p1').intel.staticReveals).toHaveLength(1);
  });

  it('keeps the viewer’s own destroyed units — your losses are your knowledge', () => {
    const state = makeState([
      makeUnit('p1-drone', 'p1', 'drone', CENTER, true),
      makeUnit('p2-drone', 'p2', 'drone', north(CENTER, 6), true),
    ]);

    const kept = filterForPlayer(state, 'p1').units;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: 'p1-drone', destroyed: true });
  });

  it('preserves GameState.units order, which pins event order (§9)', () => {
    const state = makeState([
      makeUnit('p1-a', 'p1', 'launcher', CENTER),
      makeUnit('p2-a', 'p2', 'launcher', north(CENTER, 1)),
      makeUnit('p1-b', 'p1', 'launcher', north(CENTER, 2)),
      makeUnit('p1-c', 'p1', 'launcher', north(CENTER, 3)),
    ]);

    expect(filterForPlayer(state, 'p1').units.map((u) => u.id)).toEqual([
      'p1-a',
      'p1-b',
      'p1-c',
    ]);
  });
});

// ---------------------------------------------------------------------------
// filterForPlayer — what is deliberately public
// ---------------------------------------------------------------------------

describe('filterForPlayer() — public fields', () => {
  it('never strips or masks the map (spec §11 — terrain is public)', () => {
    const state = makeState([]);
    state.map.tiles[0].terrain = 'mountain';

    const views = bothViews(state);
    expect(views.p1.map).toEqual(state.map);
    expect(views.p2.map).toEqual(state.map);
    expect(views.p1.map).toEqual(views.p2.map);
  });

  it('passes round, phase, deadHandFor and outcome through to both players', () => {
    // Their events (DEAD_HAND_TRIGGERED, GAME_OVER) go to both players, so
    // hiding the state they describe would only desynchronise a client from a
    // log it already holds.
    const state = makeState([], {
      round: 7,
      phase: 'DEAD_HAND_PHASE',
      deadHandFor: 'p2',
      outcome: { type: 'DECAPITATION', winner: 'p1' },
    });

    for (const view of Object.values(bothViews(state))) {
      expect(view.round).toBe(7);
      expect(view.phase).toBe('DEAD_HAND_PHASE');
      expect(view.deadHandFor).toBe('p2');
      expect(view.outcome).toEqual({ type: 'DECAPITATION', winner: 'p1' });
    }
  });

  it('narrows droneRespawnIn to the viewer’s own counter', () => {
    // DRONE_RESPAWNED is owner-only so the enemy cannot time your recon coming
    // back online. Leaving their counter in the state would hand them the same
    // fact directly and make filtering the event pointless.
    const state = makeState([], { droneRespawnIn: { p1: 2, p2: 0 } });

    expect(filterForPlayer(state, 'p1').droneRespawnIn).toBe(2);
    expect(filterForPlayer(state, 'p2').droneRespawnIn).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// filterForPlayer — intel and the decoy mask (spec §12)
// ---------------------------------------------------------------------------

describe('filterForPlayer() — intel', () => {
  const spotted = (): GameState =>
    makeState([], {
      intel: {
        p1: {
          staticReveals: [
            { hex: north(CENTER, 2), kind: 'decoy', round: 3 },
            { hex: north(CENTER, 4), kind: 'bunker', round: 4 },
            { hex: north(CENTER, 6), kind: 'interceptor', round: 5 },
          ],
          contacts: [
            { hex: CENTER, source: 'RECON' },
            { hex: north(CENTER, 1), source: 'LAUNCH' },
          ],
        },
        p2: {
          staticReveals: [{ hex: CENTER, kind: 'decoy', round: 2 }],
          contacts: [],
        },
      },
    });

  it('hands the viewer only their own intel', () => {
    const views = bothViews(spotted());
    expect(views.p1.intel.staticReveals).toHaveLength(3);
    expect(views.p1.intel.contacts).toHaveLength(2);
    expect(views.p2.intel.staticReveals).toHaveLength(1);
    expect(views.p2.intel.contacts).toHaveLength(0);
  });

  it('masks a spotted decoy as a bunker (spec §12)', () => {
    // The single reason this module exists. resolve() stores the truth; only
    // the filter is permitted to know the difference.
    const revealed = filterForPlayer(spotted(), 'p1').intel.staticReveals;

    expect(revealed[0]).toEqual({
      hex: north(CENTER, 2),
      kind: 'bunker',
      round: 3,
    });
    expect(revealed.map((r) => r.kind)).toEqual([
      'bunker',
      'bunker',
      'interceptor',
    ]);
  });

  it('leaves a real bunker and an interceptor base unchanged', () => {
    const revealed = filterForPlayer(spotted(), 'p1').intel.staticReveals;

    expect(revealed[1]).toEqual({
      hex: north(CENTER, 4),
      kind: 'bunker',
      round: 4,
    });
    expect(revealed[2]).toEqual({
      hex: north(CENTER, 6),
      kind: 'interceptor',
      round: 5,
    });
  });

  it('makes a masked decoy byte-identical to a real bunker seen the same round', () => {
    // The indistinguishability principle as an assertion: with the round equal,
    // nothing in the output can tell the two apart. If a field is ever added to
    // StaticReveal that differs between them, this fails.
    const state = makeState([], {
      intel: {
        p1: {
          staticReveals: [
            { hex: CENTER, kind: 'decoy', round: 3 },
            { hex: north(CENTER, 4), kind: 'bunker', round: 3 },
          ],
          contacts: [],
        },
        p2: { staticReveals: [], contacts: [] },
      },
    });

    const [fake, real] = filterForPlayer(state, 'p1').intel.staticReveals;
    expect({ ...fake, hex: null }).toEqual({ ...real, hex: null });
  });

  it('preserves the round a static asset was FIRST seen', () => {
    // "Spotted round 4" is UI flavour, not a rule — but re-photographing a
    // building that cannot move is not news, so the filter must not rewrite it.
    const revealed = filterForPlayer(spotted(), 'p1').intel.staticReveals;
    expect(revealed.map((r) => r.round)).toEqual([3, 4, 5]);
  });

  it('passes launcher contacts through untouched, source included', () => {
    // A contact is a hex plus how it was spotted — no unit id, no owner, no
    // identity to mask (spec §11: you learn a place, not a unit).
    expect(filterForPlayer(spotted(), 'p1').intel.contacts).toEqual([
      { hex: CENTER, source: 'RECON' },
      { hex: north(CENTER, 1), source: 'LAUNCH' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// filterForPlayer — purity
// ---------------------------------------------------------------------------

describe('filterForPlayer() — purity', () => {
  it('does not mutate the state it filters', () => {
    const state = makeState(
      [
        makeUnit('p1-launcher', 'p1', 'launcher', CENTER),
        makeUnit('p2-decoy', 'p2', 'decoy', north(CENTER, 5)),
      ],
      {
        intel: {
          p1: {
            staticReveals: [
              { hex: north(CENTER, 5), kind: 'decoy', round: 1 },
            ],
            contacts: [{ hex: CENTER, source: 'LAUNCH' }],
          },
          p2: { staticReveals: [], contacts: [] },
        },
      },
    );
    const before = structuredClone(state);

    filterForPlayer(state, 'p1');
    filterForPlayer(state, 'p2');

    expect(state).toEqual(before);
    // Specifically: the mask is applied to a copy, never in place.
    expect(state.intel.p1.staticReveals[0].kind).toBe('decoy');
  });

  it('hands back arrays the caller cannot splice back into the real state', () => {
    const state = makeState([makeUnit('p1-a', 'p1', 'launcher', CENTER)], {
      intel: {
        p1: {
          staticReveals: [{ hex: CENTER, kind: 'bunker', round: 1 }],
          contacts: [{ hex: CENTER, source: 'RECON' }],
        },
        p2: { staticReveals: [], contacts: [] },
      },
    });

    const view = filterForPlayer(state, 'p1');
    view.units.push(makeUnit('ghost', 'p1', 'launcher', CENTER));
    view.intel.contacts.push({ hex: north(CENTER, 1), source: 'RECON' });
    view.intel.staticReveals.push({
      hex: north(CENTER, 2),
      kind: 'bunker',
      round: 9,
    });

    expect(state.units).toHaveLength(1);
    expect(state.intel.p1.contacts).toHaveLength(1);
    expect(state.intel.p1.staticReveals).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// filterEventsForPlayer — routing (spec §6's visibility table)
// ---------------------------------------------------------------------------

describe('filterEventsForPlayer() — owner-only events', () => {
  const ownerOnly: GameEvent[] = [
    { type: 'UNIT_MOVED', unitId: 'u', owner: 'p1', from: CENTER, to: CENTER },
    { type: 'MOVE_FAILED', unitId: 'u', owner: 'p1' },
    {
      type: 'BUNKER_HIT',
      unitId: 'u',
      owner: 'p1',
      hex: CENTER,
      hpRemaining: 1,
    },
    {
      type: 'DRONE_MOVED',
      unitId: 'u',
      owner: 'p1',
      from: CENTER,
      to: CENTER,
      path: [CENTER],
    },
    { type: 'DRONE_RESPAWNED', unitId: 'u', owner: 'p1', hex: CENTER },
  ];

  it.each(ownerOnly.map((e) => [e.type, e] as const))(
    'routes %s to its owner alone',
    (_type, event) => {
      expect(audience(event)).toEqual(['p1']);
    },
  );

  it('routes the same events to p2 when p2 owns them', () => {
    const flipped = ownerOnly.map((e) => ({ ...e, owner: 'p2' as PlayerId }));
    for (const event of flipped) {
      expect(audience(event as GameEvent)).toEqual(['p2']);
    }
  });

  it('keeps a BUNKER_HIT away from the attacker — the bunker-secrecy rule', () => {
    // To the attacker a non-lethal bunker hit must be indistinguishable from
    // hitting empty ground, or blind-fire probing finds bunkers for free.
    const log: GameEvent[] = [
      { type: 'IMPACT', missileId: 'r1@0,0', hex: CENTER },
      {
        type: 'BUNKER_HIT',
        unitId: 'p2-bunker',
        owner: 'p2',
        hex: CENTER,
        hpRemaining: 1,
      },
    ];

    expect(filterEventsForPlayer(log, 'p1').map((e) => e.type)).toEqual([
      'IMPACT',
    ]);
    expect(filterEventsForPlayer(log, 'p2').map((e) => e.type)).toEqual([
      'IMPACT',
      'BUNKER_HIT',
    ]);
  });
});

describe('filterEventsForPlayer() — ASSET_SPOTTED, the backwards one', () => {
  const spottedLauncher: GameEvent = {
    type: 'ASSET_SPOTTED',
    kind: 'launcher',
    hex: CENTER,
    owner: 'p2',
  };

  it('routes it to the OWNER’S OPPONENT, not the owner', () => {
    // The trap. `owner` is the side that was photographed, so the audience is
    // the other player. Reading it like every other owner-only event shows each
    // player their own assets and hides the enemy's.
    expect(audience(spottedLauncher)).toEqual(['p1']);
  });

  it('is symmetric — a spotted p1 asset reaches p2 alone', () => {
    expect(audience({ ...spottedLauncher, owner: 'p1' })).toEqual(['p2']);
  });

  it('never tells a player about their own assets being seen', () => {
    // Stated separately from the routing test because this is the *symptom*
    // the mis-read produces, and it is the one worth failing loudly.
    const log: GameEvent[] = [
      { type: 'ASSET_SPOTTED', kind: 'bunker', hex: CENTER, owner: 'p1' },
      { type: 'ASSET_SPOTTED', kind: 'decoy', hex: CENTER, owner: 'p1' },
    ];

    expect(filterEventsForPlayer(log, 'p1')).toEqual([]);
    expect(filterEventsForPlayer(log, 'p2')).toHaveLength(2);
  });

  it('masks a spotted decoy as a bunker (spec §12)', () => {
    const log: GameEvent[] = [
      { type: 'ASSET_SPOTTED', kind: 'decoy', hex: CENTER, owner: 'p2' },
    ];

    expect(filterEventsForPlayer(log, 'p1')).toEqual([
      { type: 'ASSET_SPOTTED', kind: 'bunker', hex: CENTER, owner: 'p2' },
    ]);
  });

  it('makes a spotted decoy byte-identical to a spotted real bunker', () => {
    const asDecoy: GameEvent = {
      type: 'ASSET_SPOTTED',
      kind: 'decoy',
      hex: CENTER,
      owner: 'p2',
    };
    const asBunker: GameEvent = { ...asDecoy, kind: 'bunker' };

    expect(filterEventsForPlayer([asDecoy], 'p1')).toEqual(
      filterEventsForPlayer([asBunker], 'p1'),
    );
  });

  it('leaves launcher and interceptor sightings unmasked', () => {
    const log: GameEvent[] = [
      { type: 'ASSET_SPOTTED', kind: 'launcher', hex: CENTER, owner: 'p2' },
      { type: 'ASSET_SPOTTED', kind: 'interceptor', hex: CENTER, owner: 'p2' },
    ];

    const kinds = filterEventsForPlayer(log, 'p1').flatMap((e) =>
      e.type === 'ASSET_SPOTTED' ? [e.kind] : [],
    );
    expect(kinds).toEqual(['launcher', 'interceptor']);
  });
});

describe('filterEventsForPlayer() — public events', () => {
  const publicLog: GameEvent[] = [
    {
      type: 'LAUNCH_DETECTED',
      missileId: 'r1@10,5',
      origin: CENTER,
      target: north(CENTER, 4),
    },
    { type: 'MISSILE_INTERCEPTED', missileId: 'r1@10,5', hex: north(CENTER, 2) },
    { type: 'IMPACT', missileId: 'r1@10,5', hex: north(CENTER, 4) },
    {
      type: 'UNIT_DESTROYED',
      unitId: 'p2-launcher',
      kind: 'launcher',
      hex: north(CENTER, 4),
    },
    { type: 'DRONE_DOWNED', unitId: 'p1-drone', owner: 'p1', hex: CENTER },
    { type: 'DEAD_HAND_TRIGGERED', playerId: 'p2' },
    { type: 'GAME_OVER', outcome: { type: 'DECAPITATION', winner: 'p1' } },
  ];

  it.each(publicLog.map((e) => [e.type, e] as const))(
    'shows %s to both players',
    (_type, event) => {
      expect(audience(event)).toEqual(['p1', 'p2']);
    },
  );

  it('shows DRONE_DOWNED to the enemy despite carrying an owner', () => {
    // `owner` here names the *content*, not the audience: the defender already
    // knows their own base positions, so this leaks nothing to them.
    const downed = publicLog.find((e) => e.type === 'DRONE_DOWNED');
    expect(filterEventsForPlayer([downed!], 'p2')).toEqual([downed]);
  });

  it('reports a destroyed decoy TRUTHFULLY as a decoy (spec §6)', () => {
    // The one place the decoy is not masked, and deliberately so: the absence
    // of a dead hand in the same instant gives it away anyway, and a lie the
    // engine has to maintain is a bug waiting to happen.
    const killed: GameEvent = {
      type: 'UNIT_DESTROYED',
      unitId: 'p2-decoy',
      kind: 'decoy',
      hex: CENTER,
    };

    for (const player of ['p1', 'p2'] as PlayerId[]) {
      expect(filterEventsForPlayer([killed], player)).toEqual([killed]);
    }
  });
});

describe('filterEventsForPlayer() — the log itself', () => {
  it('preserves resolve()’s emission order', () => {
    // Clients animate straight through the array without sorting, so filtering
    // may remove entries but must never reorder the survivors (spec §6).
    const log: GameEvent[] = [
      { type: 'DRONE_MOVED', unitId: 'd', owner: 'p1', from: CENTER, to: CENTER, path: [CENTER] },
      { type: 'ASSET_SPOTTED', kind: 'launcher', hex: CENTER, owner: 'p2' },
      { type: 'LAUNCH_DETECTED', missileId: 'r1@10,5', origin: CENTER, target: CENTER },
      { type: 'MOVE_FAILED', unitId: 'm', owner: 'p2' },
      { type: 'IMPACT', missileId: 'r1@10,5', hex: CENTER },
      { type: 'UNIT_MOVED', unitId: 'u', owner: 'p1', from: CENTER, to: CENTER },
    ];

    expect(filterEventsForPlayer(log, 'p1').map((e) => e.type)).toEqual([
      'DRONE_MOVED',
      'ASSET_SPOTTED',
      'LAUNCH_DETECTED',
      'IMPACT',
      'UNIT_MOVED',
    ]);
    expect(filterEventsForPlayer(log, 'p2').map((e) => e.type)).toEqual([
      'LAUNCH_DETECTED',
      'MOVE_FAILED',
      'IMPACT',
    ]);
  });

  it('returns an empty log for an empty log', () => {
    expect(filterEventsForPlayer([], 'p1')).toEqual([]);
  });

  it('does not mutate the log it filters', () => {
    const log: GameEvent[] = [
      { type: 'ASSET_SPOTTED', kind: 'decoy', hex: CENTER, owner: 'p2' },
      { type: 'MOVE_FAILED', unitId: 'm', owner: 'p1' },
    ];
    const before = structuredClone(log);

    filterEventsForPlayer(log, 'p1');
    filterEventsForPlayer(log, 'p2');

    expect(log).toEqual(before);
  });

  it('needs no GameState — a replay can be re-filtered from the log alone', () => {
    // Not a nice-to-have: it is why every owner-only event carries `owner`, and
    // it is what lets a whole match be re-filtered for either player without
    // rebuilding the state of each round.
    const log: GameEvent[] = [
      { type: 'UNIT_MOVED', unitId: 'gone', owner: 'p1', from: CENTER, to: CENTER },
    ];

    expect(filterEventsForPlayer(log, 'p1')).toHaveLength(1);
    expect(filterEventsForPlayer(log, 'p2')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Illegal input
// ---------------------------------------------------------------------------

describe('filterEventsForPlayer() — illegal input', () => {
  it('throws rather than relabel an ASSET_SPOTTED naming a drone', () => {
    // No detector may reveal an enemy drone (spec §2, §11), so this can only
    // mean the engine invented one. A filter that quietly relabelled it would
    // hide the bug behind a working screen.
    const impossible = {
      type: 'ASSET_SPOTTED',
      kind: 'drone',
      hex: CENTER,
      owner: 'p2',
    } as GameEvent;

    expect(() => filterEventsForPlayer([impossible], 'p1')).toThrow(
      /no detector may reveal one/,
    );
  });

  it('throws rather than silently drop an event kind it does not know', () => {
    // The compiler catches this at build time (the `never` guard); the throw is
    // the runtime half, so a new event kind can never be quietly deleted from a
    // player's log.
    const unknown = { type: 'SATELLITE_PING', owner: 'p1' } as unknown as GameEvent;

    expect(() => filterEventsForPlayer([unknown], 'p1')).toThrow(
      /no audience/,
    );
  });
});

// ---------------------------------------------------------------------------
// End to end, through a real resolve() — the two cases spec §8 step 8 names
// ---------------------------------------------------------------------------

describe('the visibility filter over a real round', () => {
  const LAUNCHER_HEX = north(CENTER, 3);
  const DECOY_HEX = north(CENTER, 2);
  const DESTINATION = north(CENTER, 6);

  /**
   * p1's drone flies north over a p2 decoy and a p2 launcher, photographing
   * both, and lands 3 hexes clear of them — so the next round's hover cannot
   * re-spot either and the expiry rule is what is actually under test.
   *
   * p1 has no launcher at all, which is legal: absence is not disarmament, so
   * phase 4 returns CONTINUE and the round runs all five phases.
   */
  function round1() {
    const state = makeState([
      makeUnit('p1-drone', 'p1', 'drone', CENTER),
      makeUnit('p2-decoy', 'p2', 'decoy', DECOY_HEX),
      makeUnit('p2-launcher', 'p2', 'launcher', LAUNCHER_HEX),
    ]);

    return resolve(
      state,
      [{ type: 'FLY', unitId: 'p1-drone', destination: DESTINATION }],
      [],
      0,
    );
  }

  it('shows p1 a bunker site where p2 actually placed a decoy', () => {
    const { state, events } = round1();

    // The truth, unfiltered:
    expect(state.intel.p1.staticReveals).toEqual([
      { hex: DECOY_HEX, kind: 'decoy', round: 1 },
    ]);

    // What p1 is told, in state and in the log:
    const view = filterForPlayer(state, 'p1');
    expect(view.intel.staticReveals).toEqual([
      { hex: DECOY_HEX, kind: 'bunker', round: 1 },
    ]);
    expect(
      filterEventsForPlayer(events, 'p1').filter(
        (e) => e.type === 'ASSET_SPOTTED',
      ),
    ).toEqual([
      { type: 'ASSET_SPOTTED', kind: 'bunker', hex: DECOY_HEX, owner: 'p2' },
      { type: 'ASSET_SPOTTED', kind: 'launcher', hex: LAUNCHER_HEX, owner: 'p2' },
    ]);
  });

  it('tells p2 nothing about the flight that photographed them', () => {
    const { state, events } = round1();

    expect(filterForPlayer(state, 'p2').intel).toEqual({
      staticReveals: [],
      contacts: [],
    });
    expect(filterEventsForPlayer(events, 'p2')).toEqual([]);
  });

  it('shows p1 the launcher contact for exactly one round (spec §11)', () => {
    const first = round1();
    expect(filterForPlayer(first.state, 'p1').intel.contacts).toEqual([
      { hex: LAUNCHER_HEX, source: 'RECON' },
    ]);

    // One more resolution with no orders at all — the drone hovers where it
    // landed, out of range of both p2 assets.
    const second = resolve(first.state, [], [], 0);
    expect(filterForPlayer(second.state, 'p1').intel.contacts).toEqual([]);
  });

  it('keeps the static reveal permanently over the same two rounds', () => {
    // The contrast that makes the expiry test mean something: mobility is the
    // only thing that decides how long a sighting lasts.
    const second = resolve(round1().state, [], [], 0);

    expect(filterForPlayer(second.state, 'p1').intel.staticReveals).toEqual([
      { hex: DECOY_HEX, kind: 'bunker', round: 1 },
    ]);
  });

  it('never leaks a p2 unit id into p1’s view of the board', () => {
    const { state, events } = round1();
    const view = filterForPlayer(state, 'p1');

    expect(view.units.every((u) => u.owner === 'p1')).toBe(true);
    expect(JSON.stringify(view)).not.toContain('p2-');

    // The log is the other half: ASSET_SPOTTED carries a hex, never a unit id.
    for (const event of filterEventsForPlayer(events, 'p1')) {
      expect('unitId' in event ? event.unitId : 'p1-drone').toMatch(/^p1-/);
    }
  });
});
