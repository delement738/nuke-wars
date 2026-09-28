// Missile flight planning for the replay (presentation phase, session 2).
// Pure — no Pixi, no store.

import { describe, expect, it } from 'vitest';
import { RULES } from '../sim/defs';
import type { Hex } from '../sim/hex';
import type { PlayerId, Unit, VisibleEvent, VisibleMissile } from '../sim/types';
import { missileMarkers, planFlights, warningLine } from './flights';

const h = (q: number, r: number): Hex => ({ q, r });

/** A shot straight down column q, `range` hexes long. */
const launch = (q: number, range: number): VisibleEvent => ({
  type: 'LAUNCH_DETECTED',
  missileId: `m${q}`,
  origin: h(q, 0),
  target: h(q, range),
});
const impact = (q: number, range: number): VisibleEvent => ({
  type: 'IMPACT',
  missileId: `m${q}`,
  hex: h(q, range),
});
const intercepted = (q: number, r: number): VisibleEvent => ({
  type: 'MISSILE_INTERCEPTED',
  missileId: `m${q}`,
  hex: h(q, r),
});
const carried = (q: number, range: number, traveled: number, owner: PlayerId = 'p2'): VisibleMissile => ({
  id: `m${q}`,
  owner,
  origin: h(q, 0),
  target: h(q, range),
  launchRound: 1,
  traveled,
});

const myLauncher: Unit = {
  id: 'p1-launcher-1',
  owner: 'p1',
  kind: 'launcher',
  position: h(1, 0),
  hp: 1,
  destroyed: false,
};
const own = [myLauncher];

describe('planFlights', () => {
  it('assumes the speed rule these fixtures are written for', () => {
    // Range 6, speed 4: a 5–6 shot is the one that spends a round in the air.
    expect(RULES.missileSpeed).toBe(4);
  });

  it('flies a short shot all the way to its target in the launch clip', () => {
    const flight = planFlights([launch(1, 3), impact(1, 3)], [], own).get('m1')!;
    expect(flight.launchLeg).toEqual({ from: 0, to: 3 });
    expect(flight.finalLeg).toBeNull();
    expect(flight.end).toBe('impact');
    expect(flight.mine).toBe(true);
  });

  it('parks a range-6 shot at its 4th hex, still in flight', () => {
    const flight = planFlights([launch(2, 6)], [], own).get('m2')!;
    expect(flight.launchLeg).toEqual({ from: 0, to: 4 });
    expect(flight.finalLeg).toBeNull();
    expect(flight.end).toBe('in-flight');
    expect(flight.line[4]).toEqual(h(2, 4));
    expect(flight.mine).toBe(false); // no launcher of mine stands on its origin
  });

  it('dives last round’s missile from its 4th hex onto the target', () => {
    const flight = planFlights([impact(2, 6)], [carried(2, 6, 4)], own).get('m2')!;
    expect(flight.launchLeg).toBeNull();
    expect(flight.finalLeg).toEqual({ from: 4, to: 6 });
    expect(flight.end).toBe('impact');
    expect(flight.mine).toBe(false);
  });

  it('colours a carried missile by its owner', () => {
    const flight = planFlights([impact(2, 6)], [carried(2, 6, 4, 'p1')], own).get('m2')!;
    expect(flight.mine).toBe(true);
  });

  it('stops a missile shot down in its first leg at the intercept hex', () => {
    const flight = planFlights([launch(1, 6), intercepted(1, 2)], [], own).get('m1')!;
    expect(flight.launchLeg).toEqual({ from: 0, to: 2 });
    expect(flight.finalLeg).toBeNull();
    expect(flight.end).toBe('intercepted');
  });

  it('shoots down a carried missile on its next-round leg', () => {
    const flight = planFlights([intercepted(3, 5)], [carried(3, 6, 4)], own).get('m3')!;
    expect(flight.finalLeg).toEqual({ from: 4, to: 5 });
    expect(flight.end).toBe('intercepted');
  });

  it('splits a dead-hand shot across the two passes of one replay', () => {
    // Dead hand: launch → park → the loop flies it again and it lands (gotcha 65).
    const flight = planFlights([launch(1, 6), impact(1, 6)], [], own).get('m1')!;
    expect(flight.launchLeg).toEqual({ from: 0, to: 4 });
    expect(flight.finalLeg).toEqual({ from: 4, to: 6 });
  });

  it('plans nothing for a missile it never saw launched — its impact is just a burst', () => {
    expect(planFlights([impact(9, 3)], [], own).size).toBe(0);
  });

  it('plans an impact identically whatever it hit (spec §6, gotcha 60)', () => {
    const quiet = planFlights([launch(1, 3), impact(1, 3)], [], own);
    const hit = planFlights(
      [
        launch(1, 3),
        impact(1, 3),
        { type: 'UNIT_DESTROYED', unitId: 'p2-launcher-1', kind: 'launcher', hex: h(1, 3) },
      ],
      [],
      own,
    );
    expect(hit).toEqual(quiet);
  });

  it('never carries a launcher id into the plan', () => {
    const flight = planFlights([launch(1, 3)], [], own).get('m1')!;
    expect(JSON.stringify(flight)).not.toContain('launcher');
  });
});

describe('missileMarkers', () => {
  it('puts a parked missile on its 4th hex and warns its target, worded for the viewer', () => {
    const [enemy] = missileMarkers([carried(2, 6, 4, 'p2')], 'p1');
    expect(enemy.at).toEqual(h(2, 4));
    expect(enemy.target).toEqual(h(2, 6));
    expect(enemy.mine).toBe(false);
    expect(enemy.roundsLeft).toBe(1);
    expect(enemy.label).toBe('INBOUND — lands next round');

    const [mine] = missileMarkers([carried(2, 6, 4, 'p1')], 'p1');
    expect(mine.mine).toBe(true);
    expect(mine.label).toBe('YOUR STRIKE — lands next round');
  });

  it('shows the same missile to both players at the same place, differing only in wording', () => {
    const m = carried(3, 5, 4, 'p2');
    const [forP1] = missileMarkers([m], 'p1');
    const [forP2] = missileMarkers([m], 'p2');
    expect({ ...forP1, mine: null, label: null }).toEqual({ ...forP2, mine: null, label: null });
  });

  it('counts rounds left from the speed rule', () => {
    const [far] = missileMarkers([carried(1, 9, 0)], 'p1');
    expect(far.at).toEqual(h(1, 0));
    expect(far.roundsLeft).toBe(3);
    expect(far.label).toBe('INBOUND — lands in 3 rounds');
  });
});

describe('warningLine', () => {
  it('draws identical warnings on one hex once, and stacks different ones', () => {
    const seen = new Map<string, string[]>();
    expect(warningLine(seen, h(2, 6), 'INBOUND — lands next round')).toBe(0);
    expect(warningLine(seen, h(2, 6), 'INBOUND — lands next round')).toBeNull();
    expect(warningLine(seen, h(2, 6), 'YOUR STRIKE — lands next round')).toBe(1);
    expect(warningLine(seen, h(3, 6), 'INBOUND — lands next round')).toBe(0);
  });
});
