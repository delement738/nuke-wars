import { describe, expect, it } from 'vitest';

import type { Hex } from '../sim/hex';
import type { Outcome, PlayerId, Unit, VisibleEvent } from '../sim/types';
import { battleReports, outcomeReport } from './reports';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HEX: Hex = { q: 8, r: 12 };

/** A unit belonging to the viewer. Only `id` and `kind` matter to this module. */
function own(id: string, kind: Unit['kind'] = 'launcher'): Unit {
  return { id, owner: 'p1', kind, position: HEX, hp: 1, destroyed: false };
}

function destroyed(unitId: string, kind: Unit['kind']): VisibleEvent {
  return { type: 'UNIT_DESTROYED', unitId, kind, hex: HEX };
}

const P1: PlayerId = 'p1';

// ---------------------------------------------------------------------------
// Launcher kills — the one confirmed-kill banner in the game
// ---------------------------------------------------------------------------

describe('battleReports() — launcher destruction', () => {
  it('reports an enemy launcher as a confirmed kill', () => {
    // The id is not in the viewer's own roster, so it cannot be theirs.
    const reports = battleReports([destroyed('p2-launcher-1', 'launcher')], P1, [], 4);

    expect(reports).toHaveLength(1);
    expect(reports[0].tone).toBe('kill');
    expect(reports[0].headline).toBe('Confirmed kill');
    // Offset coordinates, matching the event log — never axial (q8 r12 is c8 r16).
    expect(reports[0].detail).toContain('c8 r16');
  });

  it('reports the viewer’s own launcher as a loss', () => {
    const reports = battleReports(
      [destroyed('p1-launcher-2', 'launcher')],
      P1,
      [own('p1-launcher-2')],
      4,
    );

    expect(reports).toHaveLength(1);
    expect(reports[0].tone).toBe('loss');
    expect(reports[0].headline).toBe('Launcher lost');
  });

  it('tells mine from theirs by the roster, not by the event', () => {
    // The same public event, read by both players. `UNIT_DESTROYED` carries no
    // `owner` (§6, §11) — the only thing that separates these two readings is
    // whether the id is in the reader's own filtered roster (gotcha 31).
    const event = destroyed('p1-launcher-2', 'launcher');

    const ownerSees = battleReports([event], 'p1', [own('p1-launcher-2')], 4);
    const enemySees = battleReports([event], 'p2', [own('p2-launcher-1')], 4);

    expect(ownerSees[0].tone).toBe('loss');
    expect(enemySees[0].tone).toBe('kill');
  });

  it('finds a destroyed unit still present in the filtered roster', () => {
    // filterForPlayer keeps the viewer's own destroyed units (§6) — if it did
    // not, a player would be congratulated for losing their own launcher.
    const wreck: Unit = { ...own('p1-launcher-3'), destroyed: true, hp: 0 };
    const reports = battleReports(
      [destroyed('p1-launcher-3', 'launcher')],
      P1,
      [wreck],
      7,
    );

    expect(reports[0].tone).toBe('loss');
  });

  it('reports every launcher lost in one round, in event order', () => {
    const reports = battleReports(
      [
        destroyed('p2-launcher-1', 'launcher'),
        destroyed('p1-launcher-1', 'launcher'),
      ],
      P1,
      [own('p1-launcher-1')],
      9,
    );

    expect(reports.map((r) => r.tone)).toEqual(['kill', 'loss']);
  });

  it('gives each report an id unique within the round', () => {
    const reports = battleReports(
      [
        destroyed('p2-launcher-1', 'launcher'),
        destroyed('p2-launcher-2', 'launcher'),
      ],
      P1,
      [],
      3,
    );

    expect(new Set(reports.map((r) => r.id)).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The negative tests. These are the load-bearing ones (see reports.ts rules 2
// and 3) — every case here is silent on purpose, and a change that starts
// reporting one is a hidden-information regression, not a feature.
// ---------------------------------------------------------------------------

describe('battleReports() — what must never produce a banner', () => {
  it('says nothing when a bunker is hit', () => {
    // Announcing this would hand the attacker a bunker detector and destroy the
    // silence-vs-destruction tell the decoy mechanic rests on (§6, §12).
    const hit: VisibleEvent = {
      type: 'BUNKER_HIT',
      unitId: 'p1-bunker',
      owner: 'p1',
      hex: HEX,
      hpRemaining: 1,
    };

    expect(battleReports([hit], P1, [own('p1-bunker', 'bunker')], 5)).toEqual([]);
  });

  it('says nothing when a decoy is destroyed', () => {
    expect(battleReports([destroyed('p2-decoy', 'decoy')], P1, [], 5)).toEqual([]);
  });

  it('says nothing when a bunker is destroyed', () => {
    // The match-ending news arrives as GAME_OVER / DEAD_HAND_TRIGGERED instead,
    // so the banner describes the outcome rather than pre-empting it.
    expect(battleReports([destroyed('p2-bunker', 'bunker')], P1, [], 5)).toEqual([]);
  });

  it('says nothing when an interceptor base is destroyed', () => {
    expect(
      battleReports([destroyed('p2-interceptor-1', 'interceptor')], P1, [], 5),
    ).toEqual([]);
  });

  it('says nothing for an impact, an interception or a launch', () => {
    const noise: VisibleEvent[] = [
      { type: 'LAUNCH_DETECTED', missileId: 'r5@8,12', origin: HEX, target: HEX },
      { type: 'MISSILE_INTERCEPTED', missileId: 'r5@8,12', hex: HEX },
      { type: 'IMPACT', missileId: 'r5@8,12', hex: HEX },
    ];

    expect(battleReports(noise, P1, [], 5)).toEqual([]);
  });

  it('says nothing for a downed drone', () => {
    const downed: VisibleEvent = {
      type: 'DRONE_DOWNED',
      unitId: 'p1-drone',
      owner: 'p1',
      hex: HEX,
    };

    expect(battleReports([downed], P1, [own('p1-drone', 'drone')], 5)).toEqual([]);
  });

  it('is silent on an ordinary round', () => {
    const ordinary: VisibleEvent[] = [
      { type: 'UNIT_MOVED', unitId: 'p1-launcher-1', owner: 'p1', from: HEX, to: HEX },
      { type: 'DRONE_MOVED', unitId: 'p1-drone', owner: 'p1', from: HEX, to: HEX, path: [HEX] },
      { type: 'ASSET_SPOTTED', kind: 'bunker', hex: HEX, owner: 'p2' },
    ];

    expect(battleReports(ordinary, P1, [], 2)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

describe('outcomeReport() — every §4 outcome, viewer-relative', () => {
  const decisive: Extract<Outcome, { winner: PlayerId }>['type'][] = [
    'DECAPITATION',
    'DISARMAMENT',
    'CAPITULATION',
  ];

  it.each(decisive)('reads %s as victory for the winner and defeat for the loser', (type) => {
    const outcome = { type, winner: 'p1' } as Outcome;

    expect(outcomeReport(outcome, 'p1').tone).toBe('victory');
    expect(outcomeReport(outcome, 'p2').tone).toBe('defeat');
  });

  const draws = ['MUTUAL_ANNIHILATION', 'MUTUAL_DISARMAMENT', 'ARMISTICE'] as const;

  it.each(draws)('reads %s as a draw for both players', (type) => {
    const outcome = { type } as Outcome;

    expect(outcomeReport(outcome, 'p1').tone).toBe('draw');
    expect(outcomeReport(outcome, 'p2').tone).toBe('draw');
    // Identical text: a draw is the one outcome with no point of view.
    expect(outcomeReport(outcome, 'p1')).toEqual(outcomeReport(outcome, 'p2'));
  });

  it('names decapitation and disarmament distinctly in both directions', () => {
    // The designer asked for these four by name, so pin the copy: a generic
    // "You win" would lose which of the two paths (§1) actually ended it.
    const decap = { type: 'DECAPITATION', winner: 'p1' } as Outcome;
    const disarm = { type: 'DISARMAMENT', winner: 'p1' } as Outcome;

    expect(outcomeReport(decap, 'p1').headline).toBe('Victory by decapitation');
    expect(outcomeReport(decap, 'p2').headline).toBe('Defeated by decapitation');
    expect(outcomeReport(disarm, 'p1').headline).toBe('Victory by disarmament');
    expect(outcomeReport(disarm, 'p2').headline).toBe('Defeated by disarmament');
  });

  it('gives every outcome a non-empty headline and detail', () => {
    const all: Outcome[] = [
      { type: 'MUTUAL_ANNIHILATION' },
      { type: 'DECAPITATION', winner: 'p1' },
      { type: 'CAPITULATION', winner: 'p1' },
      { type: 'MUTUAL_DISARMAMENT' },
      { type: 'DISARMAMENT', winner: 'p1' },
      { type: 'ARMISTICE' },
    ];

    for (const outcome of all) {
      for (const viewer of ['p1', 'p2'] as const) {
        const report = outcomeReport(outcome, viewer);
        expect(report.headline.length).toBeGreaterThan(0);
        expect(report.detail.length).toBeGreaterThan(0);
      }
    }
  });

  it('reports GAME_OVER through battleReports', () => {
    const over: VisibleEvent = {
      type: 'GAME_OVER',
      outcome: { type: 'DECAPITATION', winner: 'p1' },
    };

    expect(battleReports([over], 'p1', [], 12)[0].tone).toBe('victory');
    expect(battleReports([over], 'p2', [], 12)[0].tone).toBe('defeat');
  });

  it('reports a launcher kill and the game ending in the same round', () => {
    const finalRound: VisibleEvent[] = [
      destroyed('p2-launcher-3', 'launcher'),
      { type: 'GAME_OVER', outcome: { type: 'DISARMAMENT', winner: 'p1' } },
    ];

    const reports = battleReports(finalRound, 'p1', [], 11);

    expect(reports.map((r) => r.tone)).toEqual(['kill', 'victory']);
  });
});
