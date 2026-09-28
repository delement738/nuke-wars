// The replay queue in the store (presentation phase, session 1).
//
// The render layer plays a replay; these tests pin what it is handed and whose
// it is. The two invariants that matter: a replay is exactly the filtered slice
// that player's log received (nothing new can reach the screen this way), and
// replays are held PER PLAYER so that in hotseat nothing the person at the
// machine does can consume the other seat's (gotchas 36, 57, 58, 62).

import { beforeEach, describe, expect, it } from 'vitest';
import { PLAYERS, type PlayerId, type VisibleEvent } from '../sim/types';
import { CUE_OF, buildTimeline, type Cue } from '../render/timeline';
import {
  autoPlace,
  endTurn,
  finishReplay,
  holdUnit,
  logFor,
  matchStore,
  newMatch,
  pickHex,
  replayFor,
  resign,
  resolveRound,
  setDifficulty,
  setSeating,
  setViewer,
  takeScreen,
  viewFor,
} from './match';
import { orderableUnits } from './orders';
import { HOTSEAT_SEATS, SOLO_SEATS } from './seats';

function state() {
  return matchStore.getState();
}

/** The events `player`'s log holds for `round`, in order. */
function logSlice(player: PlayerId, round: number): VisibleEvent[] {
  return logFor(player)
    .filter((entry) => entry.round === round)
    .map((entry) => entry.event);
}

describe('solo', () => {
  beforeEach(() => {
    setSeating(SOLO_SEATS);
    newMatch();
    autoPlace();
  });

  it('has nothing to replay when the match starts', () => {
    for (const player of PLAYERS) expect(replayFor(player)).toBeNull();
  });

  it('queues a replay for both players: their own log slice, over their previous view', () => {
    const before = { p1: viewFor('p1'), p2: viewFor('p2') };
    const round = state().views!.p1.round;

    resolveRound();

    for (const player of PLAYERS) {
      const replay = replayFor(player)!;
      expect(replay.round).toBe(round);
      expect(replay.from).toBe(before[player]); // the backdrop, by reference
      expect(replay.events).toEqual(logSlice(player, round));
      expect(replay.events.length).toBeGreaterThan(0);
    }
  });

  it('never hands a player another player’s owner-only events', () => {
    resolveRound();
    for (const player of PLAYERS) {
      for (const event of replayFor(player)!.events) {
        if (event.type === 'DRONE_MOVED' || event.type === 'UNIT_MOVED') {
          expect(event.owner).toBe(player);
        }
      }
    }
  });

  it('finishReplay clears only the viewer’s replay', () => {
    resolveRound();
    finishReplay();
    expect(replayFor('p1')).toBeNull();
    expect(replayFor('p2')).not.toBeNull();
  });

  it('replaces an unwatched replay with the newer round rather than queueing it', () => {
    resolveRound();
    const second = state().views!.p1.round;
    resolveRound();
    expect(replayFor('p1')!.round).toBe(second);
  });

  it('reads a board click during a replay as “skip”, not as a selection', () => {
    resolveRound();
    const hex = viewFor('p1')!.units[0].position;

    pickHex(hex);
    expect(replayFor('p1')).toBeNull();
    expect(state().selected).toBeNull();

    pickHex(hex); // replay over: the same click selects again
    expect(state().selected).toEqual(hex);
  });

  it('plays a resignation as just the GAME_OVER', () => {
    resign('p1');
    expect(replayFor('p1')!.events.map((e) => e.type)).toEqual(['GAME_OVER']);
  });

  it('clears every replay on a new match', () => {
    resolveRound();
    newMatch();
    for (const player of PLAYERS) expect(replayFor(player)).toBeNull();
  });

  /**
   * The engine animates straight through the log without sorting, which is only
   * right because spec §6 promises the log arrives in phase order. This checks
   * that promise on real rounds — a HARD CPU marching and firing — so a change
   * to emission order in `resolve.ts` cannot silently scramble the replay.
   */
  it('receives real rounds in §6 phase order, so no sorting is needed', () => {
    const PHASE: Record<Cue, number> = {
      fly: 1, spot: 1, downed: 1,
      launch: 2, intercept: 2, exposed: 2,
      impact: 3, damage: 3,
      verdict: 4,
      move: 5,
      respawn: 6,
    };
    setDifficulty('hard');
    let launches = 0;

    for (let i = 0; i < 12 && state().views!.p1.outcome === null; i++) {
      const deadHand = state().views!.p1.phase === 'DEAD_HAND_PHASE';
      resolveRound();
      for (const player of PLAYERS) {
        const replay = replayFor(player);
        if (!replay || deadHand) continue;
        const phases = replay.events.map((e) => PHASE[CUE_OF[e.type]]);
        expect(phases).toEqual([...phases].sort((a, b) => a - b));
        launches += replay.events.filter((e) => e.type === 'LAUNCH_DETECTED').length;
        expect(buildTimeline(replay.events).duration).toBeGreaterThan(0);
      }
    }
    expect(launches).toBeGreaterThan(0); // the check saw a real volley
  });

  it('keys the replay on the viewer when spectating the CPU', () => {
    resolveRound();
    setViewer('p2');
    finishReplay();
    expect(replayFor('p2')).toBeNull();
    expect(replayFor('p1')).not.toBeNull();
  });
});

describe('hotseat', () => {
  beforeEach(() => {
    setSeating(HOTSEAT_SEATS);
    autoPlace();
  });

  /** The player at the screen holds every unit, which ends their turn. */
  function holdEverything(): void {
    const view = viewFor(state().activeSeat)!;
    for (const unit of orderableUnits(view)) holdUnit(unit.id);
  }

  function playOneRound(): number {
    const round = state().views!.p1.round;
    takeScreen(); // p1
    holdEverything();
    takeScreen(); // p2
    holdEverything(); // the last seat's turn ending resolves the round
    return round;
  }

  it('leaves both replays waiting while the screen is blanked', () => {
    playOneRound();
    expect(state().handoff).toBe('p1');
    for (const player of PLAYERS) expect(replayFor(player)).not.toBeNull();
  });

  /**
   * The load-bearing one. P1 sits down, watches (or skips) their replay, gives
   * orders and passes the screen — and P2's replay must still be there, intact,
   * when P2 sits down. Keying `finishReplay` on anything but the viewer fails it.
   */
  it('P1 finishing their replay does not consume P2’s', () => {
    const round = playOneRound();

    takeScreen(); // p1
    expect(state().viewer).toBe('p1');
    finishReplay();
    expect(replayFor('p1')).toBeNull();
    expect(replayFor('p2')).not.toBeNull();

    endTurn(); // p1 done → pass to p2
    expect(state().handoff).toBe('p2');
    expect(replayFor('p2')).not.toBeNull();

    takeScreen(); // p2
    const replay = replayFor('p2')!;
    expect(replay.round).toBe(round);
    expect(replay.events).toEqual(logSlice('p2', round));

    finishReplay();
    expect(replayFor('p2')).toBeNull();
  });
});
