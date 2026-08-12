import { describe, expect, it } from 'vitest';
import { RULES, UNIT_DEFS } from './defs';
import { offsetToAxial, type Hex } from './hex';
import type { MapData } from './map';
import { adjudicate, livingLaunchers } from './outcomes';
import type { GamePhase, GameState, PlayerId, Unit, UnitKind } from './types';

// --- fixtures ---------------------------------------------------------------
//
// adjudicate() reads three things — units, the round number and the phase — and
// nothing else, so these boards are deliberately unplayable: every unit stands
// on the same hex. Positions cannot change a §4 verdict, and pinning that by
// construction is cheaper than a realistic board that hides which field mattered.

const ONE_TILE: MapData = {
  width: 1,
  height: 1,
  tiles: [{ col: 0, row: 0, terrain: 'plains' }],
};

const HEX: Hex = offsetToAxial({ col: 0, row: 0 });

let serial = 0;

function unit(owner: PlayerId, kind: UnitKind, destroyed = false): Unit {
  serial += 1;
  return {
    id: `${owner}-${kind}-${serial}`,
    owner,
    kind,
    position: HEX,
    hp: destroyed ? 0 : UNIT_DEFS[kind].hp,
    destroyed,
  };
}

/**
 * A pair of launchers. §4 only ever asks "any left?", so two is enough to tell
 * some from none — and using fewer than §7's three keeps it obvious that the
 * count itself is not what the rule turns on.
 */
function launchers(owner: PlayerId, destroyed = false): Unit[] {
  return [unit(owner, 'launcher', destroyed), unit(owner, 'launcher', destroyed)];
}

function board(units: Unit[], overrides: Partial<GameState> = {}): GameState {
  return {
    round: 1,
    phase: 'ORDER_PHASE',
    map: ONE_TILE,
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

const DEAD_HAND_ROUND: Partial<GameState> = {
  phase: 'DEAD_HAND_PHASE' satisfies GamePhase,
  deadHandFor: 'p2',
};

/** Both sides whole: bunker, decoy and launchers each. */
function intact(): Unit[] {
  return [
    unit('p1', 'bunker'),
    unit('p1', 'decoy'),
    ...launchers('p1'),
    unit('p2', 'bunker'),
    unit('p2', 'decoy'),
    ...launchers('p2'),
  ];
}

// --- the match continues ----------------------------------------------------

describe('adjudicate() — no outcome yet', () => {
  it('lets an intact board continue', () => {
    expect(adjudicate(board(intact()))).toEqual({ type: 'CONTINUE' });
  });

  it('treats a missing bunker as absent, not destroyed', () => {
    // Most test boards in this project carry no bunker at all. Absence is not a
    // decapitation — only a bunker unit flagged destroyed is.
    const state = board([...launchers('p1'), ...launchers('p2')]);

    expect(adjudicate(state)).toEqual({ type: 'CONTINUE' });
  });

  it('treats missing launchers as absent, not disarmed', () => {
    const state = board([
      unit('p1', 'bunker'),
      unit('p1', 'drone'),
      unit('p2', 'bunker'),
      unit('p2', 'drone'),
    ]);

    expect(adjudicate(state)).toEqual({ type: 'CONTINUE' });
  });

  it('a destroyed DECOY is never an outcome and never a dead hand (§12)', () => {
    const units = intact();
    const decoy = units.find((u) => u.owner === 'p2' && u.kind === 'decoy');
    expect(decoy).toBeDefined();
    decoy!.destroyed = true;
    decoy!.hp = 0;

    expect(adjudicate(board(units))).toEqual({ type: 'CONTINUE' });
  });
});

// --- bunker outcomes (spec §4 rows 1–2) -------------------------------------

describe('adjudicate() — bunker outcomes', () => {
  it('hands a decapitated player their dead-hand round', () => {
    const units = [
      unit('p1', 'bunker'),
      ...launchers('p1'),
      unit('p2', 'bunker', true),
      ...launchers('p2'),
    ];

    expect(adjudicate(board(units))).toEqual({ type: 'DEAD_HAND', player: 'p2' });
  });

  it('skips the final round when the decapitated player has no launcher left', () => {
    const units = [
      unit('p1', 'bunker'),
      ...launchers('p1'),
      unit('p2', 'bunker', true),
      ...launchers('p2', true),
    ];

    expect(adjudicate(board(units))).toEqual({
      type: 'OUTCOME',
      outcome: { type: 'DECAPITATION', winner: 'p1' },
    });
  });

  it('both bunkers destroyed is mutual annihilation, with no dead hand (§3)', () => {
    const units = [
      unit('p1', 'bunker', true),
      ...launchers('p1'),
      unit('p2', 'bunker', true),
      ...launchers('p2'),
    ];

    expect(adjudicate(board(units))).toEqual({
      type: 'OUTCOME',
      outcome: { type: 'MUTUAL_ANNIHILATION' },
    });
  });

  it('settles the same board as decapitation once the dead-hand round is played', () => {
    // Identical units to the dead-hand trigger above — only the phase differs.
    // The final round has been played, so the bunker is now an outcome.
    const units = [
      unit('p1', 'bunker'),
      ...launchers('p1'),
      unit('p2', 'bunker', true),
      ...launchers('p2'),
    ];

    expect(adjudicate(board(units, DEAD_HAND_ROUND))).toEqual({
      type: 'OUTCOME',
      outcome: { type: 'DECAPITATION', winner: 'p1' },
    });
  });

  it('a dead-hand volley that answers in kind is mutual annihilation', () => {
    const units = [
      unit('p1', 'bunker', true),
      ...launchers('p1'),
      unit('p2', 'bunker', true),
      ...launchers('p2'),
    ];

    expect(adjudicate(board(units, DEAD_HAND_ROUND))).toEqual({
      type: 'OUTCOME',
      outcome: { type: 'MUTUAL_ANNIHILATION' },
    });
  });

  it('bunker outcomes outrank launcher outcomes (§4)', () => {
    // p1 destroyed the enemy bunker with their last surviving launcher and lost
    // it in the same resolution. They are disarmed AND decapitating; §4 says the
    // bunker wins, subject to the dead hand p2 is owed.
    const units = [
      unit('p1', 'bunker'),
      ...launchers('p1', true),
      unit('p2', 'bunker', true),
      ...launchers('p2'),
    ];

    expect(adjudicate(board(units))).toEqual({ type: 'DEAD_HAND', player: 'p2' });
  });
});

// --- launcher outcomes (spec §4 rows 4–5) -----------------------------------

describe('adjudicate() — launcher outcomes', () => {
  it('losing every launcher loses the match', () => {
    const units = [
      unit('p1', 'bunker'),
      ...launchers('p1'),
      unit('p2', 'bunker'),
      ...launchers('p2', true),
    ];

    expect(adjudicate(board(units))).toEqual({
      type: 'OUTCOME',
      outcome: { type: 'DISARMAMENT', winner: 'p1' },
    });
  });

  it('both sides disarmed is a draw', () => {
    const units = [
      unit('p1', 'bunker'),
      ...launchers('p1', true),
      unit('p2', 'bunker'),
      ...launchers('p2', true),
    ];

    expect(adjudicate(board(units))).toEqual({
      type: 'OUTCOME',
      outcome: { type: 'MUTUAL_DISARMAMENT' },
    });
  });

  it('counts only launchers — a dead drone disarms nobody', () => {
    const units = [
      ...launchers('p1'),
      unit('p2', 'drone', true),
      ...launchers('p2'),
    ];

    expect(adjudicate(board(units))).toEqual({ type: 'CONTINUE' });
  });
});

// --- the round cap (spec §4 row 6) ------------------------------------------

describe('adjudicate() — the round cap', () => {
  it('draws by armistice on the capped round', () => {
    const state = board(intact(), { round: RULES.roundCap });

    expect(adjudicate(state)).toEqual({
      type: 'OUTCOME',
      outcome: { type: 'ARMISTICE' },
    });
  });

  it('does not draw one round early', () => {
    const state = board(intact(), { round: RULES.roundCap - 1 });

    expect(adjudicate(state)).toEqual({ type: 'CONTINUE' });
  });

  it('a victory on the final round still wins', () => {
    const units = [
      unit('p1', 'bunker'),
      ...launchers('p1'),
      unit('p2', 'bunker'),
      ...launchers('p2', true),
    ];
    const state = board(units, { round: RULES.roundCap });

    expect(adjudicate(state)).toEqual({
      type: 'OUTCOME',
      outcome: { type: 'DISARMAMENT', winner: 'p1' },
    });
  });

  it('a dead hand owed on the final round is still played', () => {
    const units = [
      unit('p1', 'bunker'),
      ...launchers('p1'),
      unit('p2', 'bunker', true),
      ...launchers('p2'),
    ];
    const state = board(units, { round: RULES.roundCap });

    expect(adjudicate(state)).toEqual({ type: 'DEAD_HAND', player: 'p2' });
  });
});

// --- the helper the trigger leans on ----------------------------------------

describe('livingLaunchers()', () => {
  it('counts only this player’s surviving launchers', () => {
    const alive = unit('p1', 'launcher');
    const units = [
      alive,
      unit('p1', 'launcher', true),
      unit('p1', 'drone'),
      unit('p2', 'launcher'),
    ];

    expect(livingLaunchers(units, 'p1')).toEqual([alive]);
  });
});
