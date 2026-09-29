import { beforeEach, describe, expect, it } from 'vitest';
import { RULES } from '../sim/defs';
import { PLAYERS, opponentOf, type PlayerId, type Unit } from '../sim/types';
import {
  autoPlace,
  matchStore,
  newMatch,
  resign,
  resolveRound,
  viewFor,
} from './match';

// The end-of-match reveal (gotcha 73): the enemy's real positions, handed over
// only once the match is over.

beforeEach(() => {
  newMatch();
  autoPlace();
});

function reveal(player: PlayerId): readonly Unit[] | null {
  return matchStore.getState().finalReveal?.[player] ?? null;
}

/** The opponent's own roster, as the opponent's own view has it. */
function rosterOf(player: PlayerId): readonly Unit[] {
  const view = viewFor(player);
  if (!view) throw new Error('no match has started');
  return view.units;
}

describe('the final reveal', () => {
  it('does not exist while the match is being played', () => {
    expect(matchStore.getState().finalReveal).toBeNull();
    for (let round = 0; round < 3; round++) {
      resolveRound();
      if (viewFor('p1')?.outcome) break;
      expect(matchStore.getState().finalReveal).toBeNull();
    }
  });

  it('shows each player exactly the enemy roster once a player resigns', () => {
    resign('p1');

    for (const player of PLAYERS) {
      // The enemy's own view of its units is the truth about them, so the
      // reveal must match it exactly — every piece, and nothing of the viewer's.
      expect(reveal(player)).toEqual(rosterOf(opponentOf(player)));
      expect(reveal(player)?.every((unit) => unit.owner !== player)).toBe(true);
    }
  });

  it('names the decoy as a decoy — the mask ends with the match', () => {
    resign('p2');
    for (const player of PLAYERS) {
      const kinds = reveal(player)?.map((unit) => unit.kind);
      expect(kinds).toContain('decoy');
      expect(kinds).toContain('bunker');
      expect(kinds).toContain('interceptor');
    }
  });

  it('appears when the engine ends the match too', () => {
    // Nobody gives orders, so the CPU plays alone: someone wins or the clock
    // runs out. Either way the match ends within the round cap plus dead hand.
    for (let i = 0; i < RULES.roundCap + 2 && !viewFor('p1')?.outcome; i++) {
      resolveRound();
    }
    expect(viewFor('p1')?.outcome).not.toBeNull();

    for (const player of PLAYERS) {
      expect(reveal(player)).toEqual(rosterOf(opponentOf(player)));
    }
  });

  it('is cleared by a new match', () => {
    resign('p1');
    newMatch();
    expect(matchStore.getState().finalReveal).toBeNull();
  });
});
