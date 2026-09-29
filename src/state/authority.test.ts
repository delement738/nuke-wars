// The match authority (V1.5 Session 5, the authority split).
//
// Two things are pinned here. First, that moving the match out of the store
// changed nothing: a whole match driven through the store and the authority
// produces exactly the logs the engine gives when it is driven directly, the way
// the store did it before the split. Second, the contract a server will have to
// honour too: updates carry only filtered data, a round waits for every human
// seat, and a submission at the wrong time is ignored.

import { describe, expect, it } from 'vitest';
import { RULES } from '../sim/defs';
import { generateMap, makeRng, type MapData } from '../sim/map';
import { resolve } from '../sim/resolve';
import { startMatch, type PlayerSetup } from '../sim/setup';
import { PLAYERS, type PlayerId, type VisibleEvent } from '../sim/types';
import { filterEventsForPlayer, filterForPlayer } from '../sim/visibility';
import {
  createLocalAuthority,
  setupRng,
  type MatchUpdate,
  type MatchUpdates,
} from './authority';
import { cpuOrders, type CpuDifficulty } from './cpu';
import { cpuSetup } from './cpuSetup';
import {
  autoPlace,
  logFor,
  matchStore,
  newMatch,
  resolveRound,
  setDifficulty,
  setSeating,
  viewFor,
} from './match';
import { sandboxSetup } from './sandbox';
import { HOTSEAT_SEATS, SOLO_SEATS, type Seating } from './seats';

const CPU_SEATS: Seating = { p1: 'cpu', p2: 'cpu' };

/**
 * Both players' filtered logs for a CPU-vs-CPU match, computed straight from the
 * engine the way the store did it before the split: setups from `cpuSetup` on the
 * per-player setup stream, each round's CPU orders from the seat's own filtered
 * view and history, `makeRng(seed * 100000 + round)` for both.
 */
function referenceLogs(seed: number, difficulty: CpuDifficulty) {
  const map = generateMap(undefined, undefined, seed);
  let state = startMatch(map, {
    p1: cpuSetup(map, 'p1', difficulty, setupRng(seed, 'p1')),
    p2: cpuSetup(map, 'p2', difficulty, setupRng(seed, 'p2')),
  });
  const logs: Record<PlayerId, { round: number; event: VisibleEvent }[]> = {
    p1: [],
    p2: [],
  };

  for (let i = 0; i < RULES.roundCap && state.phase !== 'GAME_OVER'; i++) {
    const round = state.round;
    const orders = PLAYERS.map((player) =>
      cpuOrders(
        filterForPlayer(state, player),
        difficulty,
        player,
        makeRng(seed * 100000 + round),
        logs[player].map((entry) => entry.event),
      ),
    );
    const result = resolve(state, orders[0], orders[1], seed);
    state = result.state;
    for (const player of PLAYERS) {
      for (const event of filterEventsForPlayer(result.events, player)) {
        logs[player].push({ round, event });
      }
    }
  }
  return logs;
}

describe('no behaviour change', () => {
  it('a CPU-vs-CPU match through the store matches the engine driven directly', () => {
    for (const difficulty of ['medium', 'hard'] as const) {
      for (let seed = 1; seed <= 4; seed++) {
        setSeating(CPU_SEATS);
        setDifficulty(difficulty);
        newMatch(seed);
        autoPlace();
        for (let i = 0; i < RULES.roundCap && !viewFor('p1')?.outcome; i++) {
          resolveRound();
        }

        const expected = referenceLogs(seed, difficulty);
        expect(expected.p1.length).toBeGreaterThan(0);
        for (const player of PLAYERS) {
          expect(logFor(player)).toEqual(expected[player]);
        }
      }
    }
  }, 30_000);

  it('never puts the CPU seat\'s setup in the store, even once the match starts', () => {
    setSeating(SOLO_SEATS);
    newMatch(7);
    autoPlace();
    expect(matchStore.getState().placed.p2.every((slot) => slot === null)).toBe(true);
  });

  it('a solo match still starts on the human seat with nothing resolved', () => {
    setSeating(SOLO_SEATS);
    newMatch(7);
    autoPlace();
    expect(viewFor('p1')?.round).toBe(1);
    expect(logFor('p1')).toEqual([]);
  });
});

/** A local authority plus a record of every update it sent. */
function harness(seats: Seating, seed = 3) {
  const map: MapData = generateMap(undefined, undefined, seed);
  const sent: MatchUpdates[] = [];
  const authority = createLocalAuthority(
    { map, seed, seats, difficulty: 'hard' },
    (updates) => sent.push(updates),
  );
  const setup = (player: PlayerId): PlayerSetup =>
    sandboxSetup(map, player, setupRng(seed, player));
  return { authority, sent, setup };
}

describe('the local authority', () => {
  it('starts a hotseat match only once both humans have set up', () => {
    const { authority, sent, setup } = harness(HOTSEAT_SEATS);

    authority.submitSetup('p1', setup('p1'));
    expect(sent).toHaveLength(0);

    authority.submitSetup('p2', setup('p2'));
    expect(sent).toHaveLength(1);
    for (const player of PLAYERS) {
      const update = sent[0][player]!;
      expect(update.events).toEqual([]);
      expect(update.view.round).toBe(1);
    }
  });

  it('keeps orders simultaneous: one seat submitting resolves nothing', () => {
    const { authority, sent, setup } = harness(HOTSEAT_SEATS);
    authority.submitSetup('p1', setup('p1'));
    authority.submitSetup('p2', setup('p2'));

    authority.submitOrders('p1', []);
    expect(sent).toHaveLength(1);

    authority.submitOrders('p2', []);
    expect(sent).toHaveLength(2);
    expect(sent[1].p1!.round).toBe(1);
    expect(sent[1].p1!.view.round).toBe(2);
  });

  it('answers a CPU seat itself, so solo resolves on the human submission alone', () => {
    const { authority, sent, setup } = harness(SOLO_SEATS);
    authority.submitSetup('p1', setup('p1'));
    expect(sent).toHaveLength(1);

    authority.submitOrders('p1', []);
    expect(sent).toHaveLength(2);
  });

  it('ignores submissions made at the wrong time or for the wrong seat', () => {
    const { authority, sent, setup } = harness(SOLO_SEATS);

    authority.submitOrders('p1', []); // before the match
    authority.submitSetup('p2', setup('p2')); // the CPU's seat
    expect(sent).toHaveLength(0);

    authority.submitSetup('p1', setup('p1'));
    authority.submitSetup('p1', setup('p1')); // after the match started
    authority.submitOrders('p2', []); // the CPU's seat
    expect(sent).toHaveLength(1);

    authority.resign('p1');
    expect(sent).toHaveLength(2);
    authority.submitOrders('p1', []); // after the match ended
    authority.resign('p2');
    expect(sent).toHaveLength(2);
  });

  it('sends each player only their own units, and the reveal only at the end', () => {
    const { authority, sent } = harness(CPU_SEATS);
    authority.advance(); // start
    for (let i = 0; i < RULES.roundCap; i++) authority.advance();

    const all = sent.flatMap((updates) =>
      PLAYERS.map((player) => [player, updates[player]!] as const),
    );
    expect(all.at(-1)![1].view.phase).toBe('GAME_OVER');

    for (const [player, update] of all as (readonly [PlayerId, MatchUpdate])[]) {
      expect(update.view.units.every((unit) => unit.owner === player)).toBe(true);
      if (update.view.phase === 'GAME_OVER') {
        expect(update.finalReveal?.every((unit) => unit.owner !== player)).toBe(true);
      } else {
        expect(update.finalReveal).toBeNull();
      }
    }
  });

  it('does nothing on advance while a human seat still owes something', () => {
    const { authority, sent, setup } = harness(HOTSEAT_SEATS);
    authority.advance();
    authority.submitSetup('p1', setup('p1'));
    authority.advance();
    expect(sent).toHaveLength(0);

    authority.submitSetup('p2', setup('p2'));
    authority.submitOrders('p1', []);
    authority.advance();
    expect(sent).toHaveLength(1);
  });
});
