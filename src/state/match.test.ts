import { beforeEach, describe, expect, it } from 'vitest';
import { axialToOffset, hexKey, offsetToAxial } from '../sim/hex';
import { PLAYERS, type Order, type PlayerId, type VisibleEvent } from '../sim/types';
import {
  DEFAULT_DIFFICULTY,
  SANDBOX_PLAYER,
  logFor,
  matchStore,
  newMatch,
  resign,
  resolveRound,
  selectHex,
  setDifficulty,
  setViewer,
  viewFor,
} from './match';

// Every test starts from a fresh deterministic match. The store is a singleton
// (a client has exactly one match), so this is the reset.
beforeEach(() => {
  newMatch();
});

/** Every event of one kind in a player's log, narrowed. */
function eventsOfKind<K extends VisibleEvent['type']>(
  player: PlayerId,
  type: K,
): Extract<VisibleEvent, { type: K }>[] {
  return logFor(player)
    .map((entry) => entry.event)
    .filter((event): event is Extract<VisibleEvent, { type: K }> => event.type === type);
}

describe('newMatch', () => {
  it('opens a playable match for both players', () => {
    for (const player of PLAYERS) {
      const view = viewFor(player);
      expect(view.round).toBe(1);
      expect(view.phase).toBe('ORDER_PHASE');
      expect(view.outcome).toBeNull();
      // The full roster: 3 launchers + 1 drone + bunker + decoy + 2 bases (§2).
      expect(view.units).toHaveLength(8);
      expect(logFor(player)).toHaveLength(0);
    }
  });

  it('clears the previous match', () => {
    resolveRound();
    selectHex({ q: 0, r: 0 });
    setViewer('p2');

    newMatch(7);

    expect(viewFor('p1').round).toBe(1);
    expect(logFor('p1')).toHaveLength(0);
    expect(matchStore.getState().selected).toBeNull();
    expect(matchStore.getState().viewer).toBe(SANDBOX_PLAYER);
    expect(matchStore.getState().seed).toBe(7);
  });
});

describe('the filter is the only way out of the store', () => {
  // The guarantee `visibility.ts` cannot enforce for itself: every leak it
  // prevents is prevented only for callers that call it (CLAUDE.md gotcha 34).
  it('never hands a player an enemy unit', () => {
    resolveRound();

    for (const player of PLAYERS) {
      for (const unit of viewFor(player).units) {
        expect(unit.owner).toBe(player);
      }
    }
  });

  it('still shows a player their OWN decoy as a decoy', () => {
    // The mask is for the enemy (§12). Over-filtering here would be its own
    // bug: a player who cannot tell their bunker from their decoy cannot play.
    const kinds = viewFor('p1').units.map((unit) => unit.kind);
    expect(kinds).toContain('decoy');
    expect(kinds).toContain('bunker');
  });

  it('gives each player only their own drone respawn counter', () => {
    expect(viewFor('p1').droneRespawnIn).toBe(0);
    expect(typeof viewFor('p2').droneRespawnIn).toBe('number');
  });
});

describe('resolveRound', () => {
  it('advances the round for both players', () => {
    resolveRound();

    for (const player of PLAYERS) {
      expect(viewFor(player).round).toBe(2);
      expect(viewFor(player).phase).toBe('ORDER_PHASE');
    }
  });

  it('routes owner-only events to their owner alone', () => {
    // No orders at all is a legal round: launchers hold, drones hover (§3), and
    // a hovering drone still emits DRONE_MOVED to its owner (§6).
    resolveRound();

    for (const player of PLAYERS) {
      const moves = eventsOfKind(player, 'DRONE_MOVED');
      expect(moves).toHaveLength(1);
      expect(moves[0].owner).toBe(player);
    }
  });

  it('stamps each entry with the round that was resolved, not the next one', () => {
    resolveRound();
    resolveRound();

    const rounds = new Set(logFor('p1').map((entry) => entry.round));
    expect([...rounds].sort()).toEqual([1, 2]);
    expect(viewFor('p1').round).toBe(3);
  });

  it('keeps the log append-only across rounds', () => {
    resolveRound();
    const first = [...logFor('p1')];
    resolveRound();

    expect(logFor('p1').slice(0, first.length)).toEqual(first);
  });

  it('files a detected launch on the DEFENDER’s map, and only theirs', () => {
    // End-to-end proof the pipeline is wired: an order goes in, the engine
    // resolves it, and the two players get different pictures out of one truth.
    const launcher = viewFor('p1').units.find((unit) => unit.kind === 'launcher');
    if (!launcher) throw new Error('p1 has no launcher');

    const origin = axialToOffset(launcher.position);
    const order: Order = {
      type: 'LAUNCH',
      unitId: launcher.id,
      // Three hexes north — well inside range 6, and on the map from row 16.
      target: offsetToAxial({ col: origin.col, row: origin.row - 3 }),
    };

    resolveRound([order]);

    // Launches are loud: both players log the detection (§6, §11).
    for (const player of PLAYERS) {
      expect(eventsOfKind(player, 'LAUNCH_DETECTED')).toHaveLength(1);
    }

    // But the *contact* marks the defender's map only. Filing it against the
    // firer would give each player a map of their own launches (gotcha 21b).
    expect(viewFor('p2').intel.contacts).toEqual([
      { hex: launcher.position, source: 'LAUNCH' },
    ]);
    expect(viewFor('p1').intel.contacts).toHaveLength(0);
  });

  it('expires a launcher contact after one order phase', () => {
    const launcher = viewFor('p1').units.find((unit) => unit.kind === 'launcher');
    if (!launcher) throw new Error('p1 has no launcher');
    const origin = axialToOffset(launcher.position);

    resolveRound([
      {
        type: 'LAUNCH',
        unitId: launcher.id,
        target: offsetToAxial({ col: origin.col, row: origin.row - 3 }),
      },
    ]);
    expect(viewFor('p2').intel.contacts).toHaveLength(1);

    resolveRound();

    // The marker is gone (§11 rule 3) — but the history is not (§6).
    expect(viewFor('p2').intel.contacts).toHaveLength(0);
    expect(eventsOfKind('p2', 'LAUNCH_DETECTED')).toHaveLength(1);
    expect(
      eventsOfKind('p2', 'LAUNCH_DETECTED')[0].origin,
    ).toEqual(launcher.position);
  });

  it('the CPU (SANDBOX_DUMMY) actually plays, unlike the old static dummy', () => {
    // src/state/cpu.ts replaced the always-[] dummy (spec §8 step 9) with a
    // real opponent. At the default difficulty ('medium') and no intel yet on
    // round 1, every living launcher and the drone have nothing to fire at, so
    // they advance — p2's board should look different after a round resolves.
    // Difficulty-specific behaviour itself is covered exhaustively in
    // cpu.test.ts; this only pins that resolveRound() is actually wired to it.
    const before = viewFor('p2').units.map((unit) => hexKey(unit.position));

    resolveRound();
    resolveRound();

    expect(viewFor('p2').units.map((unit) => hexKey(unit.position))).not.toEqual(before);
  });

  it('is deterministic — the CPU plays identically across two fresh matches at the same seed', () => {
    resolveRound();
    const first = viewFor('p2').units.map((unit) => hexKey(unit.position));

    newMatch(matchStore.getState().seed);
    resolveRound();
    const second = viewFor('p2').units.map((unit) => hexKey(unit.position));

    expect(second).toEqual(first);
  });
});

describe('resign', () => {
  it('ends the match by capitulation, for both players', () => {
    resign('p1');

    for (const player of PLAYERS) {
      const view = viewFor(player);
      expect(view.phase).toBe('GAME_OVER');
      expect(view.outcome).toEqual({ type: 'CAPITULATION', winner: 'p2' });

      const over = eventsOfKind(player, 'GAME_OVER');
      expect(over).toHaveLength(1);
      expect(over[0].outcome).toEqual({ type: 'CAPITULATION', winner: 'p2' });
    }
  });

  it('is a no-op once the match is over, and so is another round', () => {
    resign('p2');
    const roundAfter = viewFor('p1').round;

    // The engine throws on a finished match and is right to; the store must not
    // pass a double-clicked button through to it.
    expect(() => resolveRound()).not.toThrow();
    expect(() => resign('p1')).not.toThrow();

    expect(viewFor('p1').round).toBe(roundAfter);
    expect(viewFor('p1').outcome).toEqual({ type: 'CAPITULATION', winner: 'p1' });
    expect(eventsOfKind('p1', 'GAME_OVER')).toHaveLength(1);
  });
});

describe('view controls', () => {
  it('switches which player the store reports as the viewer', () => {
    expect(matchStore.getState().viewer).toBe('p1');
    setViewer('p2');
    expect(matchStore.getState().viewer).toBe('p2');
  });

  it('drops the selection when the viewer changes', () => {
    selectHex({ q: 1, r: 1 });
    setViewer('p2');
    expect(matchStore.getState().selected).toBeNull();
  });
});

describe('setDifficulty', () => {
  it('defaults to DEFAULT_DIFFICULTY and can be changed', () => {
    expect(matchStore.getState().difficulty).toBe(DEFAULT_DIFFICULTY);
    setDifficulty('hard');
    expect(matchStore.getState().difficulty).toBe('hard');
  });

  it('survives a new match on a different map (a sandbox setting, not per-match state)', () => {
    setDifficulty('easy');
    newMatch(999);
    expect(matchStore.getState().difficulty).toBe('easy');
  });
});
