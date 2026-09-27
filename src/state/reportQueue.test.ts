// Battle reports as the *store* routes them (V1.1 step 1).
//
// `reports.test.ts` covers which events deserve a banner. This file covers the
// half that only exists once a real match is running: that each player's news is
// queued against their own seat, that whoever is at the machine can read and
// clear only their own, and that a resignation — the one event the store
// synthesises itself — still reaches both players through the filter.

import { beforeEach, describe, expect, it } from 'vitest';
import { RULES } from '../sim/defs';
import { PLAYERS, type PlayerId } from '../sim/types';
import {
  SANDBOX_PLAYER,
  autoPlace,
  dismissReport,
  matchStore,
  newMatch,
  logFor,
  reportsFor,
  resign,
  setSeating,
  setViewer,
  resolveRound,
  setDifficulty,
  takeScreen,
  viewFor,
} from './match';
import { HOTSEAT_SEATS, SOLO_SEATS, type Seating } from './seats';

function state() {
  return matchStore.getState();
}

describe('battle reports in the store — solo', () => {
  beforeEach(() => {
    setSeating(SOLO_SEATS);
    newMatch();
    autoPlace();
  });

  it('starts a match with no pending banners', () => {
    for (const player of PLAYERS) expect(reportsFor(player)).toEqual([]);
  });

  it('queues an outcome banner for both players when someone resigns', () => {
    resign(SANDBOX_PLAYER);

    // GAME_OVER is public (§6), so both sides get one — read from opposite ends.
    expect(reportsFor('p1')).toHaveLength(1);
    expect(reportsFor('p2')).toHaveLength(1);
    expect(reportsFor(SANDBOX_PLAYER)[0].tone).toBe('defeat');
    expect(reportsFor('p2')[0].tone).toBe('victory');
  });

  it('clears the viewer’s banner and leaves the other seat’s alone', () => {
    resign(SANDBOX_PLAYER);
    setViewer('p1');

    dismissReport();

    expect(reportsFor('p1')).toEqual([]);
    expect(reportsFor('p2')).toHaveLength(1);
  });

  it('is a no-op when the viewer has nothing queued', () => {
    const before = state().reports;
    dismissReport();
    expect(state().reports).toBe(before);
  });

  it('clears pending banners when a new match is rolled', () => {
    resign(SANDBOX_PLAYER);
    newMatch();

    for (const player of PLAYERS) expect(reportsFor(player)).toEqual([]);
  });
});

describe('battle reports in the store — hotseat', () => {
  beforeEach(() => {
    setSeating(HOTSEAT_SEATS);
    newMatch();
    autoPlace();
    takeScreen();
  });

  it('holds the absent player’s news until they take the screen', () => {
    // p2 is not at the machine when p1 resigns, and their banner waits rather
    // than being shown to, or dismissible by, whoever is sitting there.
    resign('p1');
    const viewer: PlayerId = state().viewer;
    const other: PlayerId = viewer === 'p1' ? 'p2' : 'p1';

    dismissReport();

    expect(reportsFor(viewer)).toEqual([]);
    expect(reportsFor(other)).toHaveLength(1);
  });

  it('shows each player their own reading of the same outcome', () => {
    resign('p1');

    expect(reportsFor('p1')[0].headline).toBe('Capitulation');
    expect(reportsFor('p2')[0].headline).toBe('Victory by capitulation');
  });
});

describe('battle reports over a whole match', () => {
  // The end-to-end wiring proof: drive real resolutions through the real engine
  // and check the banners a player accumulated against the launcher deaths in
  // their own filtered log. Nothing dismisses anything here, so the two counts
  // must agree exactly.
  //
  // Both seats are CPUs so that missiles actually fly. A human seat that holds
  // every unit produces a match in which nobody shoots anybody — the first draft
  // of this test did exactly that and passed by proving 0 === 0, which is what
  // the `sawAKill` guard below now prevents.
  const CPU_SEATS: Seating = { p1: 'cpu', p2: 'cpu' };

  function playOut(seed: number): void {
    setSeating(CPU_SEATS);
    setDifficulty('hard');
    newMatch(seed);
    autoPlace();

    for (let round = 0; round < RULES.roundCap; round++) {
      if (viewFor('p1')?.outcome) break;
      resolveRound();
    }
  }

  it('matches the banner queue to the log, across many boards', () => {
    // Swept over seeds rather than pinned to one, because the two facts worth
    // proving are rare per match: a launcher kill happens most games, a
    // *non-lethal* bunker hit does not (a second hit in the same round kills
    // outright). The guards at the end assert the sweep actually exercised
    // both, so this can never pass by proving 0 === 0 on quiet boards.
    let sawAKill = false;
    let sawAHit = false;

    for (let seed = 1; seed <= 12; seed++) {
      playOut(seed);

      for (const player of PLAYERS) {
        const log = logFor(player);
        const launcherDeaths = log.filter(
          ({ event }) =>
            event.type === 'UNIT_DESTROYED' && event.kind === 'launcher',
        ).length;
        const bunkerHits = log.filter(
          ({ event }) => event.type === 'BUNKER_HIT',
        ).length;

        const queue = reportsFor(player);
        const kills = queue.filter(
          (report) => report.tone === 'kill' || report.tone === 'loss',
        ).length;
        const outcomes = queue.filter((report) =>
          ['victory', 'defeat', 'draw'].includes(report.tone),
        ).length;

        // One banner per launcher death, at most one outcome, and nothing else
        // — so however many bunker hits landed, none of them added a banner.
        expect(kills).toBe(launcherDeaths);
        expect(outcomes).toBeLessThanOrEqual(1);
        expect(queue).toHaveLength(launcherDeaths + outcomes);

        if (launcherDeaths > 0) sawAKill = true;
        if (bunkerHits > 0) sawAHit = true;
      }
    }

    expect(sawAKill).toBe(true);
    expect(sawAHit).toBe(true);
  });
});
